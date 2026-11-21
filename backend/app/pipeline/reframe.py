"""16:9 -> vertical / square smart reframing.

Step 1  analyze_faces(): sample frames (4 fps) using OpenCV YuNet ONNX (accurate across
        tilted heads, mics, and dim lighting) with automatic fallback to Haar cascades.
Step 2  camera_path():   split at hard scene cuts so the camera snaps cleanly on cuts,
        fill gaps, median-filter, then smooth with a virtual camera dead-zone.
Step 3  build_layout():  turn the analysis into an FFmpeg filtergraph for the chosen layout.

Layouts: face_track | face_static | center | split_faces | gameplay_facecam | broll_split | blur_fill
"""
from __future__ import annotations

import logging
import os
import threading
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from ..config import effective_cpus, get_settings

log = logging.getLogger(__name__)

# (cx, cy, w, h) normalised 0..1
Face = tuple[float, float, float, float]

YUNET_FILENAME = "face_detection_yunet_2023mar.onnx"
YUNET_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"


@dataclass
class FaceTrack:
    times: list[float] = field(default_factory=list)  # relative to clip start
    faces: list[list[Face]] = field(default_factory=list)

    @property
    def hit_rate(self) -> float:
        return sum(1 for f in self.faces if f) / max(1, len(self.faces))

    def to_dict(self) -> dict:
        return {
            "times": [float(t) for t in self.times],
            "faces": [[[float(v) for v in f] for f in faces] for faces in self.faces],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "FaceTrack":
        times = [float(t) for t in (d.get("times") or [])]
        faces = [[(float(f[0]), float(f[1]), float(f[2]), float(f[3])) for f in (fs or [])]
                 for fs in (d.get("faces") or [])]
        if len(times) != len(faces):
            raise ValueError("face track is corrupt: times and faces differ in length")
        return cls(times=times, faces=faces)


_tls = threading.local()
_yunet_lock = threading.Lock()


def _yunet_model_path() -> Path | None:
    s = get_settings()
    for p in (s.models_dir / YUNET_FILENAME, s.assets_dir / "models" / YUNET_FILENAME):
        if p.is_file() and p.stat().st_size > 100_000:
            return p
    if not s.auto_download_yunet or os.environ.get("PYTEST_CURRENT_TEST"):
        return None
    with _yunet_lock:
        dest = s.models_dir / YUNET_FILENAME
        if dest.is_file() and dest.stat().st_size > 100_000:
            return dest
        tmp = dest.with_suffix(".tmp")
        try:
            log.info("downloading YuNet face detector (~228 KB) into %s", dest)
            urllib.request.urlretrieve(YUNET_URL, tmp)
            if tmp.stat().st_size > 100_000:
                os.replace(tmp, dest)
                return dest
        except Exception as e:  # noqa: BLE001
            log.info("YuNet download skipped (%s); using Haar cascades", e)
        finally:
            tmp.unlink(missing_ok=True)
    return None


def _get_yunet(sw: int, sh: int):
    import cv2

    if not hasattr(cv2, "FaceDetectorYN"):
        return None
    det = getattr(_tls, "yunet", None)
    if det is None:
        model_path = _yunet_model_path()
        if not model_path:
            return None
        try:
            det = cv2.FaceDetectorYN.create(str(model_path), "", (sw, sh), 0.65, 0.3, 5)
            _tls.yunet = det
        except Exception as e:  # noqa: BLE001
            log.warning("could not load YuNet (%s); falling back to Haar", e)
            return None
    det.setInputSize((sw, sh))
    return det


def _get_cascades():
    pair = getattr(_tls, "cascades", None)
    if pair is None:
        import cv2

        cv2.setNumThreads(min(effective_cpus(), 4))
        base = Path(cv2.data.haarcascades)
        pair = (
            cv2.CascadeClassifier(str(base / "haarcascade_frontalface_default.xml")),
            cv2.CascadeClassifier(str(base / "haarcascade_profileface.xml")),
        )
        _tls.cascades = pair
    return pair


def analyze_faces(src: str | Path, start: float, end: float, sample_fps: float = 2.0, det_width: int = 360) -> FaceTrack:
    try:
        import cv2
    except ImportError:
        log.warning("opencv not installed; using center crop")
        return FaceTrack()
    cap = cv2.VideoCapture(str(src))
    if not cap.isOpened():
        return FaceTrack()
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
    frontal, profile = _get_cascades()
    every = max(1, int(round(fps / sample_fps)))
    track = FaceTrack()
    frame_idx = 0
    total = int((end - start) * fps)
    while frame_idx <= total:
        if frame_idx % every:
            if not cap.grab():
                break
            frame_idx += 1
            continue
        ok, frame = cap.read()
        if not ok:
            break
        h, w = frame.shape[:2]
        scale = det_width / w
        sh = max(24, int(h * scale))
        small = cv2.resize(frame, (det_width, sh))
        faces: list[Face] = []
        yunet = _get_yunet(det_width, sh)
        if yunet is not None:
            _, raw = yunet.detect(small)
            if raw is not None:
                for row in raw:
                    x, y, fw, fh = float(row[0]), float(row[1]), float(row[2]), float(row[3])
                    if fw > 8 and fh > 8:
                        faces.append(((x + fw / 2) / det_width, (y + fh / 2) / sh, fw / det_width, fh / sh))
        if not faces and yunet is None:
            gray = cv2.equalizeHist(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))
            g_h, g_w = gray.shape
            min_side = max(24, int(g_h * 0.07))
            dets = frontal.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=6, minSize=(min_side, min_side))
            if len(dets) == 0:
                dets = profile.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=6, minSize=(min_side, min_side))
                if len(dets) == 0:
                    flipped = profile.detectMultiScale(cv2.flip(gray, 1), scaleFactor=1.15, minNeighbors=6, minSize=(min_side, min_side))
                    dets = [(g_w - x - fw, y, fw, fh) for (x, y, fw, fh) in flipped]
            faces = [((x + fw / 2) / g_w, (y + fh / 2) / g_h, fw / g_w, fh / g_h) for (x, y, fw, fh) in dets]
        track.times.append(frame_idx / fps)
        track.faces.append(faces)
        frame_idx += 1
    cap.release()
    return track


def _median_filter(x: np.ndarray, k: int = 5) -> np.ndarray:
    if len(x) < k:
        return x
    pad = k // 2
    xp = np.pad(x, pad, mode="edge")
    return np.array([np.median(xp[i:i + k]) for i in range(len(x))])


def _smooth_segment(times: list[float], faces_slice: list[list[Face]], smoothing: float, dead_zone: float,
                    fallback_x: float = 0.5, fallback_y: float = 0.4) -> tuple[np.ndarray, np.ndarray]:
    cx, cy = [], []
    prev = None
    for faces in faces_slice:
        if not faces:
            cx.append(np.nan)
            cy.append(np.nan)
            continue
        if prev is None:
            f = max(faces, key=lambda f: f[2] * f[3])
        else:
            f = max(faces, key=lambda f: f[2] * f[3] * 4 - abs(f[0] - prev[0]))
        prev = f
        cx.append(f[0])
        cy.append(f[1])
    cx_a, cy_a = np.array(cx, dtype=float), np.array(cy, dtype=float)
    for arr, fb in ((cx_a, fallback_x), (cy_a, fallback_y)):
        valid = ~np.isnan(arr)
        if not valid.any():
            arr[:] = fb
            continue
        idx = np.arange(len(arr))
        arr[:] = np.interp(idx, idx[valid], arr[valid])
    cx_a, cy_a = _median_filter(cx_a), _median_filter(cy_a)
    cam_x, cam_y = np.empty_like(cx_a), np.empty_like(cy_a)
    x, y = cx_a[0], cy_a[0]
    alpha = 1 - smoothing
    for i in range(len(cx_a)):
        if abs(cx_a[i] - x) > dead_zone:
            x += (cx_a[i] - x) * alpha
        if abs(cy_a[i] - y) > dead_zone:
            y += (cy_a[i] - y) * alpha
        cam_x[i], cam_y[i] = x, y
    return cam_x, cam_y


def camera_path(
    track: FaceTrack,
    smoothing: float = 0.82,
    dead_zone: float = 0.06,
    scene_cuts: list[float] | None = None,
) -> tuple[list[float], np.ndarray, np.ndarray]:
    """Return (times, cx[], cy[]) normalised, snapping cleanly across hard scene cuts."""
    if not track.times:
        return [], np.array([]), np.array([])
    if not scene_cuts:
        cam_x, cam_y = _smooth_segment(track.times, track.faces, smoothing, dead_zone)
        return track.times, cam_x, cam_y

    cuts = sorted(c for c in scene_cuts if track.times[0] < c < track.times[-1])
    if not cuts:
        cam_x, cam_y = _smooth_segment(track.times, track.faces, smoothing, dead_zone)
        return track.times, cam_x, cam_y

    out_x, out_y = [], []
    seg_start = 0
    for cut in [*cuts, track.times[-1] + 1.0]:
        seg_end = seg_start
        while seg_end < len(track.times) and track.times[seg_end] < cut:
            seg_end += 1
        if seg_end > seg_start:
            sx, sy = _smooth_segment(track.times[seg_start:seg_end], track.faces[seg_start:seg_end], smoothing, dead_zone)
            out_x.append(sx)
            out_y.append(sy)
        seg_start = seg_end
    return track.times, np.concatenate(out_x), np.concatenate(out_y)


def _rdp(points: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
    if len(points) < 3:
        return points
    (x0, y0), (x1, y1) = points[0], points[-1]
    dmax, idx = 0.0, 0
    for i in range(1, len(points) - 1):
        px, py = points[i]
        if x1 == x0:
            d = abs(py - y0)
        else:
            d = abs(py - (y0 + (y1 - y0) * (px - x0) / (x1 - x0)))
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        return _rdp(points[: idx + 1], eps)[:-1] + _rdp(points[idx:], eps)
    return [points[0], points[-1]]


def piecewise_expr(times: list[float], values: list[float], max_points: int = 48) -> str:
    pts = list(zip(times, values))
    if not pts:
        return "0"
    eps = 1.0
    simp = _rdp(pts, eps)
    while len(simp) > max_points:
        eps *= 1.6
        simp = _rdp(pts, eps)
    if len(simp) == 1 or all(abs(v - simp[0][1]) < 0.5 for _, v in simp):
        return f"{simp[0][1]:.1f}"
    terms = [f"lt(t,{simp[0][0]:.3f})*{simp[0][1]:.1f}"]
    for (t0, v0), (t1, v1) in zip(simp, simp[1:]):
        if t1 - t0 < 1e-3:
            continue
        slope = (v1 - v0) / (t1 - t0)
        terms.append(f"gte(t,{t0:.3f})*lt(t,{t1:.3f})*({v0:.1f}+{slope:.3f}*(t-{t0:.3f}))")
    terms.append(f"gte(t,{simp[-1][0]:.3f})*{simp[-1][1]:.1f}")
    return "+".join(terms)


def _even(v: float) -> int:
    return max(2, int(round(v / 2)) * 2)


def _fit(v: float, limit: int) -> int:
    return max(2, min(_even(v), limit - limit % 2))


def _zoom_expr(zoom_windows: list[tuple[float, float]], amount: float) -> str:
    if not zoom_windows or amount <= 1.0:
        return "1"
    parts = "+".join(f"between(t,{a:.2f},{b:.2f})" for a, b in zoom_windows[:40])
    return f"(1+{amount - 1:.3f}*gt({parts},0))"


@dataclass
class LayoutResult:
    filter: str  # filtergraph fragment from [0:v] to [vbase]
    layout_used: str
    notes: str = ""


def build_layout(
    layout: str,
    *,
    src_w: int,
    src_h: int,
    out_w: int,
    out_h: int,
    track: FaceTrack,
    style: dict,
    zoom_windows: list[tuple[float, float]] | None = None,
    scene_cuts: list[float] | None = None,
    has_broll: bool = False,
) -> LayoutResult:
    """Return the video filtergraph for one clip. Input label [0:v], output label [vbase]."""
    zoom_windows = zoom_windows or []
    scaler = "flags=bicubic"
    target_ar = out_w / out_h
    if src_w / src_h > target_ar:
        cw, ch = _even(src_h * target_ar), _even(src_h)
    else:
        cw, ch = _even(src_w), _even(src_w / target_ar)
    cw, ch = min(cw, src_w - src_w % 2), min(ch, src_h - src_h % 2)

    if layout in ("split_faces", "gameplay_facecam") and track.hit_rate < 0.25:
        layout = "blur_fill" if layout == "gameplay_facecam" else "face_track"

    zoom = _zoom_expr(zoom_windows, float(style.get("zoom_amount", 1.15))) if style.get("zoom_on_emphasis") else "1"

    def post_zoom(label_in: str, w: int, h: int, fy: float = 0.4, base_w: int | None = None, base_h: int | None = None) -> str:
        if zoom == "1":
            return f"[{label_in}]scale={w}:{h}:{scaler},setsar=1[vbase]"
        amount = float(style.get("zoom_amount", 1.15))
        bw, bh = base_w or cw, base_h or ch
        zw, zh = min(bw, _even(bw / amount)), min(bh, _even(bh / amount))
        cond = "gt(" + "+".join(f"between(t,{a:.2f},{b:.2f})" for a, b in zoom_windows[:40]) + ",0)"
        return (
            f"[{label_in}]crop=w='if({cond},{zw},{bw})':h='if({cond},{zh},{bh})':"
            f"x='if({cond},(iw-{zw})/2,(iw-{bw})/2)':y='if({cond},(ih-{zh})*{fy:.2f},(ih-{bh})/2)':exact=1,"
            f"scale={w}:{h}:{scaler}:eval=frame,setsar=1[vbase]"
        )

    if layout == "broll_split":
        if has_broll:
            res = _broll_split(src_w, src_h, out_w, out_h, track, scaler, scene_cuts=scene_cuts, style=style)
            if res:
                return res
        layout = "face_track"

    if layout == "split_faces":
        res = _split_faces(src_w, src_h, out_w, out_h, track, scaler)
        if res:
            return res
        layout = "face_track"

    if layout == "gameplay_facecam":
        res = _gameplay_facecam(src_w, src_h, out_w, out_h, track, scaler,
                                post_zoom=post_zoom if zoom != "1" else None)
        if res:
            return res
        layout = "blur_fill"

    if layout == "blur_fill":
        fy = float(style.get("foreground_y", 0.5))
        return LayoutResult(
            f"[0:v]split=2[bgsrc][fgsrc];"
            f"[bgsrc]scale={out_w // 4}:{out_h // 4}:force_original_aspect_ratio=increase,crop={out_w // 4}:{out_h // 4},"
            f"gblur=sigma=12,eq=brightness=-0.06:saturation=1.1,scale={out_w}:{out_h}:flags=fast_bilinear[bg];"
            f"[fgsrc]scale={out_w}:-2:{scaler}[fg];"
            f"[bg][fg]overlay=(W-w)/2:(H-h)*{fy:.2f},setsar=1[vbase]",
            "blur_fill",
        )

    if layout == "center" or not track.times or track.hit_rate < 0.1:
        x = (src_w - cw) // 2
        y = (src_h - ch) // 2
        return LayoutResult(f"[0:v]crop={cw}:{ch}:{x}:{y}[c0];" + post_zoom("c0", out_w, out_h), "center")

    times, camx, camy = camera_path(
        track,
        float(style.get("smoothing", 0.82)),
        float(style.get("dead_zone", 0.06)),
        scene_cuts=scene_cuts,
    )
    px = np.clip(camx * src_w - cw / 2, 0, src_w - cw)
    py = np.clip(camy * src_h - ch * 0.38, 0, src_h - ch)
    if layout == "face_static":
        x, y = int(np.median(px)), int(np.median(py))
        return LayoutResult(f"[0:v]crop={cw}:{ch}:{x}:{y}[c0];" + post_zoom("c0", out_w, out_h), "face_static")

    x_expr = piecewise_expr(times, list(px))
    y_expr = piecewise_expr(times, list(py)) if ch < src_h else "0"
    return LayoutResult(f"[0:v]crop={cw}:{ch}:'{x_expr}':'{y_expr}'[c0];" + post_zoom("c0", out_w, out_h), "face_track")


def _cluster_x(track: FaceTrack) -> tuple[float, float] | None:
    xs = [f[0] for faces in track.faces for f in faces]
    if len(xs) < 6:
        return None
    xs_a = np.array(xs)
    c1, c2 = np.percentile(xs_a, 20), np.percentile(xs_a, 80)
    for _ in range(10):
        a = xs_a[np.abs(xs_a - c1) <= np.abs(xs_a - c2)]
        b = xs_a[np.abs(xs_a - c1) > np.abs(xs_a - c2)]
        if len(a) == 0 or len(b) == 0:
            return None
        c1, c2 = a.mean(), b.mean()
    if abs(c2 - c1) < 0.2 or min(len(a), len(b)) < len(xs_a) * 0.15:
        return None
    return (min(c1, c2), max(c1, c2))


def _split_faces(src_w, src_h, out_w, out_h, track, lanczos) -> LayoutResult | None:
    centers = _cluster_x(track)
    if not centers:
        return None
    half_h = out_h // 2
    ar = out_w / half_h
    cw = _fit(min(src_w / 2, src_h * ar), src_w)
    ch = _fit(cw / ar, src_h)
    ys = [f[1] for faces in track.faces for f in faces]
    cy = float(np.median(ys)) if ys else 0.4
    y = int(np.clip(cy * src_h - ch * 0.42, 0, src_h - ch))
    xs = [int(np.clip(c * src_w - cw / 2, 0, src_w - cw)) for c in centers]
    return LayoutResult(
        f"[0:v]split=2[s0][s1];"
        f"[s0]crop={cw}:{ch}:{xs[0]}:{y},scale={out_w}:{half_h}:{lanczos}[top];"
        f"[s1]crop={cw}:{ch}:{xs[1]}:{y},scale={out_w}:{out_h - half_h}:{lanczos}[bot];"
        f"[top][bot]vstack=2,setsar=1[vbase]",
        "split_faces",
    )


def _gameplay_facecam(src_w, src_h, out_w, out_h, track, lanczos, post_zoom=None) -> LayoutResult | None:
    faces = [f for fs in track.faces for f in fs]
    if len(faces) < 4:
        return None
    fx = float(np.median([f[0] for f in faces]))
    fy = float(np.median([f[1] for f in faces]))
    fw = float(np.median([f[2] for f in faces]))
    top_h = int(out_h * 0.55) // 2 * 2
    bot_h = out_h - top_h
    g_ar = out_w / top_h
    gw = _fit(min(src_w, src_h * g_ar), src_w)
    gh = _fit(gw / g_ar, src_h)
    gx, gy = (src_w - gw) // 2, (src_h - gh) // 2
    b_ar = out_w / bot_h
    cw = _fit(min(src_w, max(fw * src_w * 3.5, 160)), src_w)
    ch = _fit(min(src_h, cw / b_ar), src_h)
    cw = _fit(ch * b_ar, src_w)
    cx = int(np.clip(fx * src_w - cw / 2, 0, src_w - cw))
    cy = int(np.clip(fy * src_h - ch * 0.45, 0, src_h - ch))
    graph = (
        f"[0:v]split=2[g0][f0];"
        f"[g0]crop={gw}:{gh}:{gx}:{gy},scale={out_w}:{top_h}:{lanczos}[top];"
        f"[f0]crop={cw}:{ch}:{cx}:{cy},scale={out_w}:{bot_h}:{lanczos}[bot];"
    )
    if post_zoom is not None:
        graph += "[top][bot]vstack=2,setsar=1[vpre];" + post_zoom("vpre", out_w, out_h, 0.3, out_w, out_h)
    else:
        graph += "[top][bot]vstack=2,setsar=1[vbase]"
    return LayoutResult(graph, "gameplay_facecam")


def _broll_split(src_w, src_h, out_w, out_h, track, lanczos, *, scene_cuts=None, style=None) -> LayoutResult | None:
    """Speaker on top (55%), looping B-roll clip on bottom (45%). Uses [broll:v] placeholder."""
    style = style or {}
    top_h = int(out_h * 0.55) // 2 * 2
    bot_h = out_h - top_h
    ar = out_w / top_h
    cw = _fit(min(src_w, src_h * ar), src_w)
    ch = _fit(cw / ar, src_h)
    if track.times and track.hit_rate >= 0.1:
        times, camx, camy = camera_path(track, float(style.get("smoothing", 0.82)), float(style.get("dead_zone", 0.06)), scene_cuts=scene_cuts)
        px = np.clip(camx * src_w - cw / 2, 0, src_w - cw)
        py = np.clip(camy * src_h - ch * 0.4, 0, src_h - ch)
        x_expr = piecewise_expr(times, list(px))
        y_expr = piecewise_expr(times, list(py)) if ch < src_h else "0"
        top_crop = f"crop={cw}:{ch}:'{x_expr}':'{y_expr}'"
    else:
        tx, ty = (src_w - cw) // 2, (src_h - ch) // 2
        top_crop = f"crop={cw}:{ch}:{tx}:{ty}"
    return LayoutResult(
        f"[0:v]{top_crop},scale={out_w}:{top_h}:{lanczos}[top];"
        f"[broll:v]scale={out_w}:{bot_h}:force_original_aspect_ratio=increase,crop={out_w}:{bot_h},fps=30[bot];"
        f"[top][bot]vstack=2,setsar=1[vbase]",
        "broll_split",
    )

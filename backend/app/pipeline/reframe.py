"""16:9 -> 9:16 smart reframing.

Step 1  analyze_faces(): sample frames (4 fps) with OpenCV's bundled Haar cascades, at a
        small resolution so it is cheap on a laptop CPU.
Step 2  camera_path():   choose the face to follow, fill gaps, median-filter, then a
        "virtual camera" with a dead-zone and easing, so it pans only when the subject
        really moves (no jitter).
Step 3  build_layout():  turn the analysis into an FFmpeg filtergraph for the chosen layout.

All crops come straight from the full-resolution source and are scaled once with
Lanczos to the output size, so quality is preserved (no double scaling, no stretching).

Layouts: face_track | face_static | center | split_faces | gameplay_facecam | blur_fill
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

# (cx, cy, w, h) normalised 0..1
Face = tuple[float, float, float, float]


@dataclass
class FaceTrack:
    times: list[float] = field(default_factory=list)  # relative to clip start
    faces: list[list[Face]] = field(default_factory=list)

    @property
    def hit_rate(self) -> float:
        return sum(1 for f in self.faces if f) / max(1, len(self.faces))

    def to_dict(self) -> dict:
        """Plain JSON-safe form (lossless: floats survive json.dumps / json.loads exactly)."""
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


# One pair of classifiers per thread: detectMultiScale on a shared CascadeClassifier
# is not guaranteed thread-safe, and several clips can be analysed at once.
_tls = threading.local()


def _get_cascades():
    pair = getattr(_tls, "cascades", None)
    if pair is None:
        import cv2

        from ..config import effective_cpus

        cv2.setNumThreads(min(effective_cpus(), 4))  # more threads only add memory here
        base = Path(cv2.data.haarcascades)
        pair = (
            cv2.CascadeClassifier(str(base / "haarcascade_frontalface_default.xml")),
            cv2.CascadeClassifier(str(base / "haarcascade_profileface.xml")),
        )
        _tls.cascades = pair
    return pair


def analyze_faces(src: str | Path, start: float, end: float, sample_fps: float = 4.0, det_width: int = 480) -> FaceTrack:
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
        small = cv2.resize(frame, (det_width, int(h * scale)))
        gray = cv2.equalizeHist(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))
        sh, sw = gray.shape
        min_side = max(24, int(sh * 0.07))
        dets = frontal.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=6, minSize=(min_side, min_side))
        if len(dets) == 0:
            dets = profile.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=6, minSize=(min_side, min_side))
            if len(dets) == 0:  # profile facing the other way
                flipped = profile.detectMultiScale(cv2.flip(gray, 1), scaleFactor=1.15, minNeighbors=6, minSize=(min_side, min_side))
                dets = [(sw - x - fw, y, fw, fh) for (x, y, fw, fh) in flipped]
        faces = [((x + fw / 2) / sw, (y + fh / 2) / sh, fw / sw, fh / sh) for (x, y, fw, fh) in dets]
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


def camera_path(track: FaceTrack, smoothing: float = 0.82, dead_zone: float = 0.06) -> tuple[list[float], np.ndarray, np.ndarray]:
    """Return (times, cx[], cy[]) normalised, for the subject the camera follows."""
    if not track.times:
        return [], np.array([]), np.array([])
    cx, cy = [], []
    prev = None
    for faces in track.faces:
        if not faces:
            cx.append(np.nan)
            cy.append(np.nan)
            continue
        if prev is None:
            f = max(faces, key=lambda f: f[2] * f[3])
        else:  # prefer big faces near where the camera already is (continuity)
            f = max(faces, key=lambda f: f[2] * f[3] * 4 - abs(f[0] - prev[0]))
        prev = f
        cx.append(f[0])
        cy.append(f[1])
    cx_a, cy_a = np.array(cx, dtype=float), np.array(cy, dtype=float)
    for arr in (cx_a, cy_a):
        valid = ~np.isnan(arr)
        if not valid.any():
            arr[:] = 0.5 if arr is cx_a else 0.4
            continue
        idx = np.arange(len(arr))
        arr[:] = np.interp(idx, idx[valid], arr[valid])  # fill gaps (holds edges)
    cx_a, cy_a = _median_filter(cx_a), _median_filter(cy_a)
    # virtual camera: ignore small moves, ease towards big ones
    cam_x, cam_y = np.empty_like(cx_a), np.empty_like(cy_a)
    x, y = cx_a[0], cy_a[0]
    alpha = 1 - smoothing
    for i in range(len(cx_a)):
        if abs(cx_a[i] - x) > dead_zone:
            x += (cx_a[i] - x) * alpha
        if abs(cy_a[i] - y) > dead_zone:
            y += (cy_a[i] - y) * alpha
        cam_x[i], cam_y[i] = x, y
    return track.times, cam_x, cam_y


def _rdp(points: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
    """Ramer-Douglas-Peucker simplification (keeps the FFmpeg expression short)."""
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
    """Linear interpolation of keyframes as an FFmpeg expression of t (evaluated per frame)."""
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
    """Nearest even size that still fits inside `limit` (sources can have odd sizes, like 853x479)."""
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


def build_layout(layout: str, *, src_w: int, src_h: int, out_w: int, out_h: int, track: FaceTrack,
                 style: dict, zoom_windows: list[tuple[float, float]] | None = None) -> LayoutResult:
    """Return the video filtergraph for one clip. Input label [0:v], output label [vbase]."""
    zoom_windows = zoom_windows or []
    lanczos = "flags=lanczos"
    target_ar = out_w / out_h
    # largest crop of the source with the target aspect
    if src_w / src_h > target_ar:
        cw, ch = _even(src_h * target_ar), _even(src_h)
    else:
        cw, ch = _even(src_w), _even(src_w / target_ar)
    cw, ch = min(cw, src_w - src_w % 2), min(ch, src_h - src_h % 2)

    if layout in ("split_faces", "gameplay_facecam") and track.hit_rate < 0.25:
        layout = "blur_fill" if layout == "gameplay_facecam" else "face_track"

    zoom = _zoom_expr(zoom_windows, float(style.get("zoom_amount", 1.15))) if style.get("zoom_on_emphasis") else "1"

    def post_zoom(label_in: str, w: int, h: int, fy: float = 0.4) -> str:
        if zoom == "1":
            return f"[{label_in}]scale={w}:{h}:{lanczos},setsar=1[vbase]"
        # Punch-in: one normal branch and one pre-zoomed branch, switched on during the
        # emphasis windows. Both scalers have a fixed size. The earlier single scale with
        # eval=frame rebuilt its Lanczos kernels for every frame (about 15% of render time).
        amount = float(style.get("zoom_amount", 1.15))
        zw, zh = min(cw, _even(cw / amount)), min(ch, _even(ch / amount))
        cond = "gt(" + "+".join(f"between(t,{a:.2f},{b:.2f})" for a, b in zoom_windows[:40]) + ",0)"
        return (f"[{label_in}]split=2[zn][zz];"
                f"[zn]scale={w}:{h}:{lanczos}[zbase];"
                f"[zz]crop={zw}:{zh}:(iw-{zw})/2:(ih-{zh})*{fy:.2f},scale={w}:{h}:{lanczos}[zin];"
                f"[zbase][zin]overlay=0:0:enable='{cond}',setsar=1[vbase]")

    if layout == "split_faces":
        res = _split_faces(src_w, src_h, out_w, out_h, track, lanczos)
        if res:
            return res
        layout = "face_track"

    if layout == "gameplay_facecam":
        res = _gameplay_facecam(src_w, src_h, out_w, out_h, track, lanczos)
        if res:
            return res
        layout = "blur_fill"

    if layout == "blur_fill":
        fy = float(style.get("foreground_y", 0.5))
        return LayoutResult(
            f"[0:v]split=2[bgsrc][fgsrc];"
            f"[bgsrc]scale={out_w // 4}:{out_h // 4}:force_original_aspect_ratio=increase,crop={out_w // 4}:{out_h // 4},"
            f"gblur=sigma=12,eq=brightness=-0.06:saturation=1.1,scale={out_w}:{out_h}[bg];"
            f"[fgsrc]scale={out_w}:-2:{lanczos}[fg];"
            f"[bg][fg]overlay=(W-w)/2:(H-h)*{fy:.2f},setsar=1[vbase]",
            "blur_fill",
        )

    if layout == "center" or not track.times or track.hit_rate < 0.1:
        x = (src_w - cw) // 2
        y = (src_h - ch) // 2
        return LayoutResult(f"[0:v]crop={cw}:{ch}:{x}:{y}[c0];" + post_zoom("c0", out_w, out_h), "center")

    times, camx, camy = camera_path(track, float(style.get("smoothing", 0.82)), float(style.get("dead_zone", 0.06)))
    px = np.clip(camx * src_w - cw / 2, 0, src_w - cw)
    py = np.clip(camy * src_h - ch * 0.38, 0, src_h - ch)  # keep eyes in the upper third
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
    for _ in range(10):  # 1-D k-means, k=2
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


def _gameplay_facecam(src_w, src_h, out_w, out_h, track, lanczos) -> LayoutResult | None:
    faces = [f for fs in track.faces for f in fs]
    if len(faces) < 4:
        return None
    fx = float(np.median([f[0] for f in faces]))
    fy = float(np.median([f[1] for f in faces]))
    fw = float(np.median([f[2] for f in faces]))
    top_h = int(out_h * 0.55) // 2 * 2
    bot_h = out_h - top_h
    # gameplay: centre crop with the top panel's aspect
    g_ar = out_w / top_h
    gw = _fit(min(src_w, src_h * g_ar), src_w)
    gh = _fit(gw / g_ar, src_h)
    gx, gy = (src_w - gw) // 2, (src_h - gh) // 2
    # facecam: box ~3.5x the face width around the face
    b_ar = out_w / bot_h
    cw = _fit(min(src_w, max(fw * src_w * 3.5, 160)), src_w)
    ch = _fit(min(src_h, cw / b_ar), src_h)
    cw = _fit(ch * b_ar, src_w)
    cx = int(np.clip(fx * src_w - cw / 2, 0, src_w - cw))
    cy = int(np.clip(fy * src_h - ch * 0.45, 0, src_h - ch))
    return LayoutResult(
        f"[0:v]split=2[g0][f0];"
        f"[g0]crop={gw}:{gh}:{gx}:{gy},scale={out_w}:{top_h}:{lanczos}[top];"
        f"[f0]crop={cw}:{ch}:{cx}:{cy},scale={out_w}:{bot_h}:{lanczos}[bot];"
        f"[top][bot]vstack=2,setsar=1[vbase]",
        "gameplay_facecam",
    )

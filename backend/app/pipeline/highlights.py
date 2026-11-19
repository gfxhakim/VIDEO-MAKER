"""Viral-moment detection, scoring, silence-cut calculation, and metadata helpers."""
from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass, field

import numpy as np

WEIGHTS = {
    "hook": 1.6,
    "density": 1.0,
    "energy": 1.1,
    "spikes": 0.9,
    "emotion": 1.2,
    "dead_air": -1.2,
    "action": 0.6,
    "complete": 0.6,
    "length_fit": 0.5,
}

HOOK_PHRASES = [
    # English
    "here's why", "here is why", "the secret", "nobody", "no one", "never", "stop", "the truth", "the reason",
    "how to", "how i", "what if", "did you know", "you won't believe", "i can't believe", "the biggest", "the worst",
    "the best", "mistake", "if you", "you need", "you have to", "listen", "watch this", "look at", "this is why",
    "let me tell you", "the problem", "everyone", "most people", "wait", "bro", "oh my god", "what the",
    "unpopular opinion", "hear me out", "don't ever", "the hack", "3 things", "five things", "changed my life",
    # Spanish / French / German / Portuguese / Arabic hooks
    "por qué", "el secreto", "nadie te", "la verdad", "no hagas", "escucha", "mira esto",
    "pourquoi", "le secret", "personne ne", "la vérité", "écoute", "regarde",
    "warum", "das geheimnis", "niemand", "die wahrheit", "hör zu",
    "por que", "o segredo", "ninguém", "a verdade", "olha isso",
    "لماذا", "السر", "الحقيقة", "لا أحد", "اسمع", "شاهد",
]

EMOTION_WORDS = set(
    """amazing awesome insane crazy unbelievable incredible love hate angry mad furious scared terrified shocked
    shocking wow omg holy damn hell literally actually seriously absolutely never always biggest worst best ever
    huge massive million billion money rich broke dead kill killed died crying cry laugh laughing funny hilarious
    secret truth lie lied lying fake real exposed wrong right winning won lost lose crazy wild sick fire goat
    beautiful disgusting obsessed addicted dangerous illegal impossible
    increible locura verdad secreto dinero nunca siempre mejor peor imposible
    incroyable fou vérité secret argent jamais toujours meilleur pire impossible
    unglaublich verrückt wahrheit geheimnis geld niemals immer beste schlechteste""".split()
)

STOPWORDS = set(
    """a an the and or but if then so to of in on at for with from by is are was were be been being i you he she it
    we they me him her us them my your his its our their this that these those there here what which who whom whose
    when where why how all any both each few more most other some such no nor not only own same than too very can
    will just don't do does did doing have has had having would should could i'm you're it's that's gonna wanna yeah
    like know really get got go going one thing things um uh okay ok oh well right also because about up out
    need want said says tell tells told make made just even still much many back over into then them than
    wait listen look gonna kind sort mean thing stuff come came take took give gave keep every
    today yesterday tomorrow people everyone everybody someone somebody anyone nobody something anything everything
    actually basically literally probably maybe definitely honestly seriously totally always never""".split()
)

LEADING_FILLER = re.compile(r"^(?:(?:um|uh|ah|er|so|well|like|yeah|okay|ok|basically|actually|literally)[,\s]+)+", re.I)


@dataclass
class Sentence:
    start: float
    end: float
    text: str
    n_words: int


@dataclass
class Candidate:
    start: float
    end: float
    score: float = 0.0
    breakdown: dict = field(default_factory=dict)
    text: str = ""
    hook: str = ""

    @property
    def duration(self) -> float:
        return self.end - self.start


def build_sentences(words: list[dict], max_gap: float = 0.8, max_len: float = 12.0) -> list[Sentence]:
    out: list[Sentence] = []
    cur: list[dict] = []

    def flush():
        if cur:
            out.append(Sentence(cur[0]["start"], cur[-1]["end"], " ".join(w["word"] for w in cur), len(cur)))
            cur.clear()

    for w in words:
        if cur and (w["start"] - cur[-1]["end"] > max_gap or w["end"] - cur[0]["start"] > max_len):
            flush()
        cur.append(w)
        if re.search(r"[.!?…؟]$", w["word"]):
            flush()
    flush()
    return out


def _norm(v: float, lo: float, hi: float) -> float:
    if hi <= lo:
        return 0.0
    return float(min(1.0, max(0.0, (v - lo) / (hi - lo))))


def _hook_score(text: str) -> float:
    t = text.lower()
    s = 0.0
    if "?" in t or "؟" in t:
        s += 0.35
    if any(p in t for p in HOOK_PHRASES):
        s += 0.4
    if re.search(r"\d|\$|percent|%", t):
        s += 0.2
    if re.search(r"\byou\b|\byour\b|\btu\b|\bvous\b|\bdu\b", t):
        s += 0.15
    if "!" in t:
        s += 0.1
    n = len(t.split())
    if 4 <= n <= 18:
        s += 0.15
    return min(1.0, s)


def _emotion_score(text: str) -> float:
    toks = re.findall(r"[\w']+", text.lower())
    if not toks:
        return 0.0
    hits = sum(1 for t in toks if t in EMOTION_WORDS)
    excl = text.count("!")
    laughs = len(re.findall(r"\b(ha){2,}|\blol\b|\blmao\b", text.lower()))
    return min(1.0, (hits / len(toks)) * 8 + excl * 0.05 + laughs * 0.2)


class Scorer:
    """Pre-computes per-step arrays so each window is scored in O(1)."""

    def __init__(self, duration: float, words: list[dict], energy_db: np.ndarray, energy_step: float, scene_cuts: list[float]):
        self.duration = duration
        self.step = energy_step
        n = max(1, int(math.ceil(duration / energy_step)) + 1)
        e = np.full(n, -60.0, dtype=np.float64)
        e[: min(n, len(energy_db))] = energy_db[:n]
        self.energy = e
        ref = e[e > -55] if np.any(e > -55) else e
        self.e_mean, self.e_std = float(np.mean(ref)), float(np.std(ref) + 1e-6)
        z = (e - self.e_mean) / self.e_std
        spikes = ((z > 1.6) & (np.concatenate([[0], np.diff(z)]) > 0.6)).astype(np.float64)
        speech = np.zeros(n)
        word_count = np.zeros(n)
        for w in words:
            a, b = int(w["start"] / energy_step), int(w["end"] / energy_step) + 1
            speech[a:b] = 1
            word_count[min(n - 1, a)] += 1
        cuts = np.zeros(n)
        for c in scene_cuts:
            cuts[min(n - 1, int(c / energy_step))] += 1
        self._cs = {k: np.concatenate([[0], np.cumsum(v)]) for k, v in
                    {"z": z, "spikes": spikes, "speech": speech, "words": word_count, "cuts": cuts}.items()}
        self.has_speech = bool(words)

    def _sum(self, key: str, a: float, b: float) -> float:
        cs = self._cs[key]
        last = len(cs) - 1
        i = min(max(0, int(a / self.step)), last)
        j = min(max(i + 1, int(b / self.step)), last)
        return float(cs[j] - cs[i])

    def longest_pause(self, a: float, b: float) -> float:
        i, j = int(a / self.step), int(b / self.step)
        sp = self._cs["speech"]
        best = cur = 0
        for k in range(i, min(j, len(sp) - 1)):
            if sp[k + 1] - sp[k] == 0:
                cur += 1
                best = max(best, cur)
            else:
                cur = 0
        return best * self.step

    def score(self, c: Candidate, first_sentence: str, pref_len: float, ends_clean: bool) -> None:
        d = max(0.1, c.duration)
        steps = d / self.step
        b: dict[str, float] = {}
        b["energy"] = _norm(self._sum("z", c.start, c.end) / steps, -0.5, 1.0)
        b["spikes"] = _norm(self._sum("spikes", c.start, c.end) / d * 30, 0, 3)
        b["action"] = _norm(self._sum("cuts", c.start, c.end) / d * 10, 0, 4)
        if self.has_speech:
            wps = self._sum("words", c.start, c.end) / d
            b["density"] = max(0.0, 1 - abs(wps - 3.0) / 2.0)
            speech_ratio = self._sum("speech", c.start, c.end) / steps
            b["dead_air"] = _norm(max(1 - speech_ratio - 0.15, 0) + max(0, self.longest_pause(c.start, c.end) - 1.5) / 4, 0, 1)
            b["hook"] = _hook_score(first_sentence)
            b["emotion"] = _emotion_score(c.text)
            b["complete"] = 1.0 if ends_clean else 0.3
        else:
            b.update(density=0.0, dead_air=0.0, hook=0.0, emotion=0.0, complete=0.5)
            b["hook"] = _norm(self._sum("z", c.start, c.start + 3) / (3 / self.step), -0.5, 1.5)
        b["length_fit"] = max(0.0, 1 - abs(d - pref_len) / max(pref_len, 1))
        raw = sum(WEIGHTS[k] * v for k, v in b.items())
        max_raw = sum(w for w in WEIGHTS.values() if w > 0)
        c.breakdown = {k: round(v, 3) for k, v in b.items()}
        c.score = round(100 * max(0.0, raw) / max_raw, 1)


def _overlap(a: Candidate, b: Candidate) -> float:
    inter = max(0.0, min(a.end, b.end) - max(a.start, b.start))
    return inter / max(1e-6, min(a.duration, b.duration))


def select_highlights(
    *, duration: float, words: list[dict], energy_db: np.ndarray, energy_step: float, scene_cuts: list[float],
    count: int, min_len: float, max_len: float,
) -> list[Candidate]:
    min_len = min(min_len, max(5.0, duration * 0.9))
    max_len = max(min_len + 1, min(max_len, duration))
    pref_len = min(max_len, max(min_len, (min_len + max_len) / 2 * 0.8))
    scorer = Scorer(duration, words, energy_db, energy_step, scene_cuts)
    cands: list[Candidate] = []

    sentences = build_sentences(words) if words else []
    if len(sentences) >= 3:
        for i, s0 in enumerate(sentences):
            text_parts = []
            for j in range(i, len(sentences)):
                sj = sentences[j]
                text_parts.append(sj.text)
                d = sj.end - s0.start
                if d > max_len:
                    break
                if d >= min_len:
                    start = max(0.0, s0.start - 0.15)
                    end = min(duration, sj.end + 0.35)
                    c = Candidate(start, end, text=" ".join(text_parts), hook=s0.text)
                    ends_clean = bool(re.search(r"[.!?…؟]$", sj.text))
                    scorer.score(c, s0.text, pref_len, ends_clean)
                    cands.append(c)
    else:
        step = max(2.0, min_len / 3)
        t = 0.0
        while t + min_len <= duration:
            for L in sorted({min_len, pref_len, max_len}):
                if t + L <= duration:
                    c = Candidate(t, t + L)
                    scorer.score(c, "", pref_len, True)
                    cands.append(c)
            t += step

    cands.sort(key=lambda c: c.score, reverse=True)
    chosen: list[Candidate] = []
    for max_ov in (0.1, 0.35, 0.6):
        for c in cands:
            if len(chosen) >= count:
                break
            if all(_overlap(c, k) <= max_ov for k in chosen):
                chosen.append(c)
        if len(chosen) >= count:
            break
    chosen.sort(key=lambda c: c.score, reverse=True)
    return chosen


def silence_cuts(words: list[dict], clip_duration: float, *, min_gap: float = 0.65, pad: float = 0.08) -> list[tuple[float, float]]:
    """Compute kept [start, end] speech segments inside a clip (removes pauses > `min_gap`)."""
    if not words or clip_duration <= 1.0:
        return [(0.0, clip_duration)]
    segs: list[tuple[float, float]] = []
    cur_a = max(0.0, words[0]["start"] - pad)
    cur_b = min(clip_duration, words[0]["end"] + pad)
    for w in words[1:]:
        wa = max(0.0, w["start"] - pad)
        wb = min(clip_duration, w["end"] + pad)
        if wa - cur_b > min_gap - 2 * pad:
            if cur_b - cur_a > 0.15:
                segs.append((round(cur_a, 3), round(cur_b, 3)))
            cur_a, cur_b = wa, wb
        else:
            cur_b = max(cur_b, wb)
    if cur_b - cur_a > 0.15:
        segs.append((round(cur_a, 3), round(cur_b, 3)))
    if not segs or sum(b - a for a, b in segs) < 2.0:
        return [(0.0, clip_duration)]
    # Keep at least 95% if barely anything was cut so we don't pay extra concat filter cost unnecessarily
    if sum(b - a for a, b in segs) >= clip_duration - 0.5:
        return [(0.0, clip_duration)]
    return segs


# ----------------------------------------------------------------- metadata
def make_title(hook: str, text: str, max_len: int = 80) -> str:
    base = (hook or text or "").strip()
    base = re.sub(r"\s+", " ", base)
    cleaned = LEADING_FILLER.sub("", base).strip()
    if len(cleaned) >= 12:
        base = cleaned
    if not base:
        return "Wait for it..."
    base = base[0].upper() + base[1:]
    if len(base) > max_len:
        base = base[: max_len - 1].rsplit(" ", 1)[0] + "…"
    return base


def make_hashtags(text: str, n: int = 4) -> list[str]:
    toks = [t.lower() for t in re.findall(r"[A-Za-z][A-Za-z']{3,}", text)]
    counts = Counter(t for t in toks if t not in STOPWORDS and "'" not in t)
    ranked = sorted(counts, key=lambda w: counts[w] * (1 + len(w) / 5) + (2 if w in EMOTION_WORDS else 0), reverse=True)
    tags = ranked[:n]
    return [f"#{t}" for t in tags] + ["#shorts", "#viral", "#fyp"]

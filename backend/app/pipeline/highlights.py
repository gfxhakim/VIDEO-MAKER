"""High-precision viral-moment detection, speech-complete boundary alignment, silence cuts, and metadata."""
from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass, field

import numpy as np

WEIGHTS = {
    "hook": 2.0,       # Opening punch + curiosity gap + vocal attack
    "emotion": 1.3,    # Emotional words, stakes, exclamations, laughter
    "arc": 1.1,        # Story payoff + vocal dynamics
    "energy": 1.0,     # Vocal conviction
    "density": 0.9,    # Ideal pace + concrete content richness (low filler)
    "spikes": 0.9,     # Emotional spikes / reactions
    "complete": 1.3,   # Clean opener + finishes when speaker finishes words or stops talking
    "action": 0.5,     # Visual cuts
    "length_fit": 0.4, # Sweet-spot duration
    "dead_air": -1.4,  # Strong penalty for long awkward pauses
}

HOOK_PHRASES = [
    # Contrarian / curiosity gap / viral openers (EN)
    "here's why", "here is why", "here's how", "the secret", "nobody tells", "nobody talks about", "no one",
    "never do", "stop doing", "the truth is", "the truth about", "the reason", "how i ", "why i ",
    "what if", "did you know", "you won't believe", "i can't believe", "the biggest mistake", "the biggest",
    "the worst", "the best way", "the problem is", "most people", "everyone thinks", "unpopular opinion",
    "hear me out", "don't ever", "the hack", "changed my life", "watch this", "watch what", "look at this",
    "let me tell you", "this is why", "you need to", "you have to", "imagine if", "the crazy part",
    "crazy thing", "real reason", "wait until", "million dollars", "zero to",
    # Spanish / French / German / Portuguese / Arabic hooks
    "por qué", "el secreto", "nadie te", "la verdad", "no hagas", "escucha", "mira esto",
    "pourquoi", "le secret", "personne ne", "la vérité", "écoute", "regarde",
    "warum", "das geheimnis", "niemand", "die wahrheit", "hör zu",
    "por que", "o segredo", "ninguém", "a verdade", "olha isso",
    "لماذا", "السر", "الحقيقة", "لا أحد", "اسمع", "شاهد",
]

WEAK_OPENER_RE = re.compile(r"^(?:and|but|so|or|then|well|anyway|also|meanwhile|however|yeah|um|uh)\b", re.I)
WEAK_ENDING_RE = re.compile(
    r"(?:stuff like that|or whatever|you know what i mean|and everything|and stuff|kind of|sort of|i guess)\W*$",
    re.I,
)
ABBREVS = {"mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "vs.", "etc.", "e.g.", "i.e.", "u.s.", "u.k.", "no."}

EMOTION_WORDS = set(
    """amazing awesome insane crazy unbelievable incredible love hate angry mad furious scared terrified shocked
    shocking wow omg holy damn hell literally actually seriously absolutely never always biggest worst best ever
    huge massive million billion thousand money rich broke dead kill killed died crying cry laugh laughing funny hilarious
    secret truth lie lied lying fake real exposed wrong right winning won lost lose crazy wild sick fire goat
    beautiful disgusting obsessed addicted dangerous illegal impossible trap scam fail failed regret
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
    word_start_idx: int = 0
    word_end_idx: int = 0
    is_terminal: bool = False
    pause_after: float = 0.0
    pause_before: float = 0.0


@dataclass
class Candidate:
    start: float
    end: float
    score: float = 0.0
    breakdown: dict = field(default_factory=dict)
    text: str = ""
    hook: str = ""
    ends_clean: bool = True

    @property
    def duration(self) -> float:
        return self.end - self.start


def _is_sentence_end(word: str) -> bool:
    stripped = word.strip().rstrip("\"'”’)]»")
    if not stripped:
        return False
    if stripped[-1] in ("!", "?", "…", "؟"):
        return True
    if not stripped.endswith("."):
        return False
    low = stripped.lower()
    if low in ABBREVS or re.fullmatch(r"[A-Za-z]\.", stripped) or re.search(r"\d\.$", stripped):
        return False
    return True


def build_sentences(words: list[dict], max_gap: float = 0.72, max_len: float = 22.0) -> list[Sentence]:
    """Group timestamped words into complete sentences / natural speech-pause units."""
    out: list[Sentence] = []
    cur: list[dict] = []
    cur_indices: list[int] = []

    def flush(next_start: float | None = None):
        if not cur:
            return
        w_start = cur_indices[0]
        w_end = cur_indices[-1]
        prev_end = words[w_start - 1]["end"] if w_start > 0 else 0.0
        pause_before = max(0.0, cur[0]["start"] - prev_end) if w_start > 0 else 2.0
        pause_after = max(0.0, next_start - cur[-1]["end"]) if next_start is not None else 5.0
        out.append(Sentence(
            start=cur[0]["start"],
            end=cur[-1]["end"],
            text=" ".join(w["word"] for w in cur),
            n_words=len(cur),
            word_start_idx=w_start,
            word_end_idx=w_end,
            is_terminal=_is_sentence_end(cur[-1]["word"]),
            pause_after=pause_after,
            pause_before=pause_before,
        ))
        cur.clear()
        cur_indices.clear()

    for idx, w in enumerate(words):
        if cur:
            gap = w["start"] - cur[-1]["end"]
            dur = w["end"] - cur[0]["start"]
            comma_pause = bool(re.search(r"[,;—–-]$", cur[-1]["word"].strip())) and gap >= 0.25 and dur >= 10.0
            speech_stop = gap >= 0.48 and len(cur) >= 3
            if gap > max_gap or speech_stop or comma_pause or dur > max_len:
                flush(next_start=w["start"])
        cur.append(w)
        cur_indices.append(idx)
        if _is_sentence_end(w["word"]):
            next_s = words[idx + 1]["start"] if idx + 1 < len(words) else None
            flush(next_start=next_s)
    flush(next_start=None)
    return out


def _norm(v: float, lo: float, hi: float) -> float:
    if hi <= lo:
        return 0.0
    return float(min(1.0, max(0.0, (v - lo) / (hi - lo))))


def _speech_safe_bounds(
    words: list[dict],
    w_start_idx: int,
    w_end_idx: int,
    duration: float,
    energy_db: np.ndarray | None = None,
    energy_step: float = 0.25,
) -> tuple[float, float]:
    """Compute clip boundaries so words never start mid-syllable and always finish after speech stops."""
    w0 = words[w_start_idx]
    w1 = words[w_end_idx]

    # Start: lead slightly before w0, strictly after prev word finishes
    if w_start_idx <= 0:
        start = max(0.0, w0["start"] - 0.15)
    else:
        prev_end = float(words[w_start_idx - 1]["end"])
        gap_before = max(0.0, w0["start"] - prev_end)
        if gap_before >= 0.08:
            start = max(prev_end + 0.04, w0["start"] - min(0.18, gap_before * 0.6))
        else:
            start = (prev_end + w0["start"]) / 2.0

    # End: leave room for final consonants/breath decay, stop cleanly before next word begins
    has_next = w_end_idx + 1 < len(words)
    next_start = float(words[w_end_idx + 1]["start"]) if has_next else duration
    gap_after = max(0.0, next_start - float(w1["end"]))

    if not has_next:
        tail = min(0.42, max(0.18, duration - w1["end"]))
        end = min(duration, w1["end"] + tail)
    elif gap_after >= 0.12:
        tail = min(0.36, max(0.18, gap_after * 0.65))
        if energy_db is not None and len(energy_db):
            quiet_floor = float(np.percentile(energy_db, 20)) + 4.0
            scan_until = min(next_start - 0.05, w1["end"] + 0.55)
            t = w1["end"] + 0.15
            while t <= scan_until:
                k = int(t / energy_step)
                if 0 <= k < len(energy_db) and energy_db[k] > quiet_floor:
                    tail = max(tail, (t - w1["end"]) + 0.10)
                    t += energy_step
                else:
                    break
        end = min(next_start - 0.04, w1["end"] + min(0.55, tail))
    else:
        # Tight transition to next word: land right in the micro-gap so final word finishes cleanly
        end = (w1["end"] + next_start) / 2.0

    return max(0.0, start), min(duration, max(start + 0.5, end))


def snap_range_to_speech(
    words: list[dict],
    start: float,
    end: float,
    duration: float,
    *,
    max_extend: float = 4.0,
) -> tuple[float, float]:
    """Snap a user-picked [start, end] range so it finishes on complete spoken words or sentence end."""
    if not words:
        return max(0.0, start), min(duration, end)
    sents = build_sentences(words)
    # Pick first word starting at/after start - 0.25
    start_idx = next((i for i, w in enumerate(words) if (w["start"] + w["end"]) / 2.0 >= start - 0.1), 0)
    # Prefer a clean sentence ending near `end` (in [end - 2.0, end + max_extend])
    best_sent = None
    best_dist = 1e9
    for s in sents:
        if s.word_end_idx <= start_idx:
            continue
        if (s.is_terminal or s.pause_after >= 0.35) and (end - 2.0) <= s.end <= (end + max_extend):
            dist = abs(s.end - end) + (0.0 if s.end >= end - 0.5 else 0.8)
            if dist < best_dist:
                best_dist = dist
                best_sent = s
    if best_sent is not None:
        end_idx = best_sent.word_end_idx
    else:
        # Fall back to last word overlapping/starting near `end`, extending slightly past its end
        cand = [i for i, w in enumerate(words) if i >= start_idx and w["start"] <= end + 0.35]
        end_idx = cand[-1] if cand else min(len(words) - 1, start_idx)
    if end_idx <= start_idx:
        return max(0.0, start), min(duration, end)
    s_out, e_out = _speech_safe_bounds(words, start_idx, end_idx, duration)
    if e_out - s_out < 1.5:
        return max(0.0, start), min(duration, end)
    return round(s_out, 3), round(e_out, 3)


def _hook_score(first_sentence: str, next_sentence: str = "") -> float:
    raw = first_sentence.strip()
    cleaned = LEADING_FILLER.sub("", raw).strip()
    t = cleaned.lower()
    if not t:
        t = raw.lower()
    s = 0.0
    if "?" in t or "؟" in t:
        s += 0.34
    phrase_hits = sum(1 for p in HOOK_PHRASES if p in t)
    if phrase_hits:
        s += min(0.55, 0.36 + (phrase_hits - 1) * 0.14)
    if re.search(r"\$\s*\d|\d+\s*%|\b\d+x\b|\b\d{2,}\b|\b(three|four|five|seven|ten|\d+)\s+(ways|things|steps|reasons|mistakes|rules|secrets)\b", t):
        s += 0.25
    elif re.search(r"\d", t):
        s += 0.14
    if re.search(r"\byou\b|\byour\b|\btu\b|\bvous\b|\bdu\b", t):
        s += 0.14
    if "!" in raw:
        s += 0.10
    toks = re.findall(r"[\w']+", t)
    if 4 <= len(toks) <= 18:
        s += 0.12
    # Also reward strong immediate follow-up line if s0 is a short punch ("Wait. Look at what happened next.")
    if next_sentence and len(toks) <= 4:
        nxt = LEADING_FILLER.sub("", next_sentence).strip().lower()
        if any(p in nxt for p in HOOK_PHRASES) or "?" in nxt or re.search(r"\d", nxt):
            s += 0.22
    # Penalize weak dependent/trailing openers unless backed by a genuine hook pattern
    if WEAK_OPENER_RE.match(raw) and phrase_hits == 0 and "?" not in raw:
        s *= 0.55
    return min(1.0, s)


def _emotion_score(text: str) -> float:
    toks = re.findall(r"[\w']+", text.lower())
    if not toks:
        return 0.0
    hits = sum(1 for t in toks if t in EMOTION_WORDS)
    excl = text.count("!")
    ques = text.count("?") + text.count("؟")
    laughs = len(re.findall(r"\b(ha){2,}|\blol\b|\blmao\b", text.lower()))
    numbers = len(re.findall(r"\$\d+|\d+%|\b\d+[kmb]\b", text.lower()))
    return min(1.0, (hits / len(toks)) * 8.5 + excl * 0.06 + ques * 0.05 + laughs * 0.22 + numbers * 0.12)


def _content_richness(text: str) -> float:
    toks = re.findall(r"[A-Za-z][A-Za-z']{2,}", text.lower())
    if not toks:
        return 0.0
    content = [t for t in toks if t not in STOPWORDS and "'" not in t]
    ratio = len(content) / len(toks)
    uniq_bonus = min(1.0, len(set(content)) / max(6, len(toks) * 0.4))
    return float(min(1.0, ratio * 1.15 * 0.6 + uniq_bonus * 0.4))


def _payoff_score(last_sentence: str) -> float:
    lt = last_sentence.strip()
    if not lt:
        return 0.3
    if WEAK_ENDING_RE.search(lt):
        return 0.15
    s = 0.45
    if lt[-1:] in ("!", "?"):
        s += 0.22
    toks = re.findall(r"[\w']+", lt.lower())
    if any(t in EMOTION_WORDS for t in toks):
        s += 0.22
    if re.search(r"\d|\$|%", lt):
        s += 0.14
    if 4 <= len(toks) <= 15:
        s += 0.12
    return min(1.0, s)


class Scorer:
    """Pre-computes per-step arrays so each candidate window is scored in O(1)."""

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
        self.z = z
        spikes = ((z > 1.55) & (np.concatenate([[0], np.diff(z)]) > 0.55)).astype(np.float64)
        speech = np.zeros(n)
        word_count = np.zeros(n)
        for w in words:
            a = min(n - 1, max(0, int(w["start"] / energy_step)))
            b = min(n, max(a + 1, int(w["end"] / energy_step) + 1))
            speech[a:b] = 1
            word_count[a] += 1
        cuts = np.zeros(n)
        for c in scene_cuts:
            cuts[min(n - 1, max(0, int(c / energy_step)))] += 1
        self._cs = {k: np.concatenate([[0], np.cumsum(v)]) for k, v in
                    {"z": z, "z2": z * z, "spikes": spikes, "speech": speech, "words": word_count, "cuts": cuts}.items()}
        self.has_speech = bool(words)

    def _sum(self, key: str, a: float, b: float) -> float:
        cs = self._cs[key]
        last = len(cs) - 1
        i = min(max(0, int(a / self.step)), last)
        j = min(max(i + 1, int(b / self.step)), last)
        return float(cs[j] - cs[i])

    def _z_std(self, a: float, b: float) -> float:
        last = len(self.z)
        i = min(max(0, int(a / self.step)), max(0, last - 1))
        j = min(max(i + 1, int(b / self.step)), last)
        seg = self.z[i:j]
        return float(np.std(seg)) if len(seg) > 1 else 0.0

    def longest_pause(self, a: float, b: float) -> float:
        i, j = max(0, int(a / self.step)), int(b / self.step)
        sp = self._cs["speech"]
        best = cur = 0
        for k in range(i, min(j, len(sp) - 1)):
            if sp[k + 1] - sp[k] == 0:
                cur += 1
                best = max(best, cur)
            else:
                cur = 0
        return best * self.step

    def score(
        self,
        c: Candidate,
        first_sentence: str,
        pref_len: float,
        ends_clean: bool,
        *,
        next_sentence: str = "",
        last_sentence: str = "",
        topic_start: bool = True,
        strong_pause_end: bool = False,
    ) -> None:
        d = max(0.1, c.duration)
        steps = d / self.step
        b: dict[str, float] = {}
        b["energy"] = _norm(self._sum("z", c.start, c.end) / steps, -0.5, 1.0)
        b["spikes"] = _norm(self._sum("spikes", c.start, c.end) / d * 30, 0, 3)
        b["action"] = _norm(self._sum("cuts", c.start, c.end) / d * 10, 0, 4)

        dyn = _norm(self._z_std(c.start, c.end), 0.35, 1.35)
        hook_energy = _norm(self._sum("z", c.start, min(c.end, c.start + 3.0)) / (min(3.0, d) / self.step), -0.4, 1.4)

        if self.has_speech:
            wps = self._sum("words", c.start, c.end) / d
            pace = max(0.0, 1 - abs(wps - 3.05) / 1.9)
            rich = _content_richness(c.text)
            b["density"] = round(0.6 * pace + 0.4 * rich, 3)
            speech_ratio = self._sum("speech", c.start, c.end) / steps
            b["dead_air"] = _norm(
                max(1 - speech_ratio - 0.14, 0) + max(0.0, self.longest_pause(c.start, c.end) - 1.25) / 3.5,
                0,
                1,
            )
            text_hook = _hook_score(first_sentence, next_sentence)
            b["hook"] = round(min(1.0, 0.78 * text_hook + 0.22 * hook_energy), 3)
            b["emotion"] = _emotion_score(c.text)
            payoff = _payoff_score(last_sentence or first_sentence)
            b["arc"] = round(min(1.0, 0.6 * payoff + 0.4 * dyn), 3)
            if ends_clean:
                base_complete = 1.0 if strong_pause_end else 0.90
                b["complete"] = base_complete if topic_start else base_complete - 0.12
            else:
                b["complete"] = 0.05
        else:
            b.update(density=0.0, dead_air=0.0, emotion=0.0, complete=0.75)
            b["hook"] = round(hook_energy, 3)
            b["arc"] = round(dyn, 3)

        b["length_fit"] = max(0.0, 1 - abs(d - pref_len) / max(pref_len, 1))
        raw = sum(WEIGHTS[k] * v for k, v in b.items())
        max_raw = sum(w for w in WEIGHTS.values() if w > 0)
        c.breakdown = {k: round(v, 3) for k, v in b.items()}
        c.ends_clean = ends_clean
        c.score = round(100 * max(0.0, min(1.0, raw / max_raw)), 1)


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
            topic_start = i == 0 or sentences[i - 1].is_terminal or s0.pause_before >= 0.35
            nxt_sent = sentences[i + 1].text if i + 1 < len(sentences) else ""
            row_clean: list[Candidate] = []
            row_any: list[Candidate] = []
            for j in range(i, len(sentences)):
                sj = sentences[j]
                text_parts.append(sj.text)
                raw_d = sj.end - s0.start
                if raw_d > max_len:
                    break
                if raw_d + 0.5 >= min_len:
                    start, end = _speech_safe_bounds(
                        words, s0.word_start_idx, sj.word_end_idx, duration,
                        energy_db=energy_db, energy_step=energy_step,
                    )
                    if end - start < min_len - 0.5 or end - start > max_len + 0.6:
                        continue
                    ends_clean = sj.is_terminal or sj.pause_after >= 0.35
                    strong_pause_end = sj.pause_after >= 0.35
                    c = Candidate(start, end, text=" ".join(text_parts), hook=s0.text, ends_clean=ends_clean)
                    scorer.score(
                        c,
                        s0.text,
                        pref_len,
                        ends_clean,
                        next_sentence=nxt_sent,
                        last_sentence=sj.text,
                        topic_start=topic_start,
                        strong_pause_end=strong_pause_end,
                    )
                    if ends_clean:
                        row_clean.append(c)
                    else:
                        row_any.append(c)
            # Only emit incomplete mid-clause endings if this start index has zero clean endings
            cands.extend(row_clean if row_clean else row_any)
    else:
        step = max(2.0, min_len / 3)
        t = 0.0
        while t + min_len <= duration:
            for L in sorted({min_len, pref_len, max_len}):
                if t + L <= duration:
                    c = Candidate(t, t + L, ends_clean=True)
                    scorer.score(c, "", pref_len, True)
                    cands.append(c)
            t += step

    cands.sort(key=lambda c: c.score, reverse=True)
    clean_pool = [c for c in cands if c.ends_clean]
    rest_pool = [c for c in cands if not c.ends_clean]

    chosen: list[Candidate] = []
    # Two-pass selection: exhaust clean finished-speech clips before ever considering an unpunctuated fallback
    for pool in (clean_pool, rest_pool):
        if len(chosen) >= count or not pool:
            continue
        for max_ov in (0.1, 0.35, 0.6):
            for c in pool:
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
    # Give final spoken word a generous breath tail so jump-cut clips end smoothly after speech finishes
    tail_b = min(clip_duration, max(cur_b, float(words[-1]["end"]) + 0.24))
    if tail_b - cur_a > 0.15:
        segs.append((round(cur_a, 3), round(tail_b, 3)))
    if not segs or sum(b - a for a, b in segs) < 2.0:
        return [(0.0, clip_duration)]
    # Keep full clip if barely anything was cut so we don't pay extra concat filter cost unnecessarily
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


def make_hook_text(hook: str, text: str, max_len: int = 58) -> str:
    """Short, punchy headline with a contextual iOS emoji for the visual hook card."""
    base = (hook or text or "").strip()
    base = re.sub(r"\s+", " ", base)
    cleaned = LEADING_FILLER.sub("", base).strip()
    if len(cleaned) >= 10:
        base = cleaned
    if not base:
        return "Wait for it 🔥"
    clauses = [c.strip(" ,;:-") for c in re.split(r"(?<=[.!?])\s+|[,;—–]\s+", base) if c.strip(" ,;:-")]
    picked = clauses[0] if clauses else base
    if len(picked.split()) < 3 and len(clauses) > 1 and len(picked) + len(clauses[1]) + 2 <= max_len - 3:
        picked = f"{picked}, {clauses[1]}"
    base = picked.rstrip(".,;:-") or "Wait for it"
    base = base[0].upper() + base[1:]
    has_emoji = any(ord(ch) >= 0x1F000 or 0x2600 <= ord(ch) <= 0x27BF for ch in base)
    limit = max_len - (0 if has_emoji else 3)
    if len(base) > limit:
        cut = base[: limit - 1].rsplit(" ", 1)[0].rstrip(".,;:-")
        base = (cut or base[: limit - 1]) + "…"
    if not has_emoji:
        from .captions import emoji_for
        found = None
        for tok in base.split():
            found = emoji_for(tok)
            if found:
                break
        if not found and text:
            for tok in text.split()[:20]:
                found = emoji_for(tok)
                if found:
                    break
        if not found:
            found = "🤯" if ("?" in base or "!" in base) else "🔥"
        base = f"{base} {found}"
    return base


def make_hashtags(text: str, n: int = 4) -> list[str]:
    toks = [t.lower() for t in re.findall(r"[A-Za-z][A-Za-z']{3,}", text)]
    counts = Counter(t for t in toks if t not in STOPWORDS and "'" not in t)
    ranked = sorted(counts, key=lambda w: counts[w] * (1 + len(w) / 5) + (2 if w in EMOTION_WORDS else 0), reverse=True)
    tags = ranked[:n]
    return [f"#{t}" for t in tags] + ["#shorts", "#viral", "#fyp"]

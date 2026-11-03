"""Pure helpers (no torch import) so they unit-test anywhere."""
import math
import re

_PAIR = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(?:-|to|\.\.)\s*(\d+(?:\.\d+)?)\s*$")


def parse_regions(text):
    """'4-8; 14.5-18' -> [(4.0, 8.0), (14.5, 18.0)]. Commas, semicolons or newlines separate pairs."""
    out = []
    for part in re.split(r"[;,\n]+", text or ""):
        if not part.strip():
            continue
        m = _PAIR.match(part)
        if not m:
            raise ValueError(f"bad region {part.strip()!r}; use start-end in seconds, e.g. 4-8")
        a, b = float(m.group(1)), float(m.group(2))
        if b <= a:
            raise ValueError(f"region {part.strip()!r} ends before it starts")
        out.append((a, b))
    return sorted(out)


def frame_span(a, b, rate, n_frames):
    """Seconds -> [lo, hi) latent frame span, widened to whole frames and clamped."""
    lo = max(0, min(n_frames, int(math.floor(a * rate))))
    hi = max(lo, min(n_frames, int(math.ceil(b * rate))))
    return lo, hi


def keep_spans(regions, src_seconds, total_seconds):
    """Complement of regions within [0, src_seconds): the audio that survives pasteback."""
    keep, t = [], 0.0
    for a, b in regions:
        a, b = max(0.0, a), min(src_seconds, b)
        if a > t:
            keep.append((t, min(a, src_seconds)))
        t = max(t, b)
    if t < src_seconds:
        keep.append((t, src_seconds))
    return [(a, b) for a, b in keep if b > a and a < total_seconds]

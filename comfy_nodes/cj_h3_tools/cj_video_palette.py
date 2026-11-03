"""CJVideoPalette: regrade a video clip to a palette (hex colors) or to a reference still, flicker-free.

One grade per clip, never per frame: ffmpeg samples ~24 frames spread over the clip at analysis size, and
the grade is fitted ONCE in OKLab from those samples:
  1. Monge-Kantorovich linear transfer (mean + covariance) from the clip's colour statistics to the target's
     (the reference still's pixels, or the palette as a weighted colour mixture with a little spread);
  2. palette mode only: a soft nearest-swatch pull (Gaussian-weighted in OKLab) toward the palette chroma;
  3. gamut fit (chroma compression, not channel clipping), optional "keep source luminance" (OKLab L kept),
     optional skin-tone protection (strength fades on the skin hue/chroma band of the SOURCE colour), and the
     strength blend.
All of that is baked into a 33^3 RGB 3D LUT (written next to the MP4 as an Adobe/Resolve .cube), expanded
once to a 256^3 byte table, and every decoded frame is one table lookup: identical input pixels always map
to identical output pixels, so there is nothing that can flicker. The source audio is muxed back unchanged
(AAC). CPU only, numpy + ffmpeg, no models.

Palette string: up to 16 colours, "#rrggbb" (or "#rgb"), separated by commas/spaces/semicolons, each with an
optional ":weight" (e.g. "#1b2a41:2, #e0b36a"). When `palette` is non-empty it wins over `reference`.
"""
import json
import math
import os
import re
import subprocess

import numpy as np

# Colour handling for the raw-RGB pipes (one copy per module so each loads on its own):
# - decode: full-chroma bicubic yuv->rgb (+3 dB PSNR vs the default chroma upsampling on a 4:2:0 clip),
#   matrix from the stream's tags (untagged = BT.601, same as ComfyUI's own decode)
# - encode: BT.709 matrix + tags, so browsers (which show untagged HD as BT.709) and tag-aware decoders
#   both see the right colours (untagged BT.601 output played back as BT.709 measured -10 dB).
RGB_DECODE_VF = "scale=flags=bicubic+accurate_rnd+full_chroma_int,format=rgb24"
BT709_ENCODE_VF = ("scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,"
                   "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv")

LUT_SIZE = 33
MAX_COLORS = 16
ANALYSIS_WIDTH = 256
DEFAULT_SAMPLES = 24
MAX_FPS = 60.0
#: eigenvalue clamp for the linear transfer: never flatten a colour axis below 0.2x or blow it up past 2.5x
#: (a near-grey source + a saturated palette would otherwise amplify chroma noise without bound)
GAIN_MIN, GAIN_MAX = 0.2, 2.5
#: palette mode: how much of the clip's own covariance is kept in the target (keeps contrast/texture)
PALETTE_COV_KEEP = 0.4
REFERENCE_COV_KEEP = 0.1
PALETTE_SPREAD = np.array([0.05, 0.02, 0.02])  # per-swatch std-dev in OKLab (L, a, b)
PULL_TAU = 0.07
PULL_AB = 0.55
PULL_L = 0.15


# colour math


def srgb_to_linear(c):
    c = np.asarray(c, np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(np.asarray(c, np.float64), 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


_M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
                [0.2119034982, 0.6806995451, 0.1073969566],
                [0.0883024619, 0.2817188376, 0.6299787005]])
_M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
                [1.9779984951, -2.4285922050, 0.4505937099],
                [0.0259040371, 0.7827717662, -0.8086757660]])
_M1_INV = np.linalg.inv(_M1)
_M2_INV = np.linalg.inv(_M2)


def linear_to_oklab(rgb):
    lms = np.asarray(rgb, np.float64) @ _M1.T
    return np.cbrt(lms) @ _M2.T


def oklab_to_linear(lab):
    lms = (np.asarray(lab, np.float64) @ _M2_INV.T) ** 3
    return lms @ _M1_INV.T


def srgb_to_oklab(srgb):
    """sRGB in 0..1 (..., 3) -> OKLab (..., 3)."""
    return linear_to_oklab(srgb_to_linear(srgb))


def oklab_to_srgb(lab):
    """OKLab -> sRGB 0..1 with gamut fit by chroma compression (hue and lightness kept)."""
    return linear_to_srgb(gamut_fit(lab))


def gamut_fit(lab, iters=12):
    """Linear sRGB of OKLab colours; out-of-gamut colours get their chroma scaled down (binary search)."""
    lab = np.asarray(lab, np.float64).copy()
    lab[..., 0] = np.clip(lab[..., 0], 0.0, 1.0)
    rgb = oklab_to_linear(lab)
    eps = 1e-6
    bad = np.any((rgb < -eps) | (rgb > 1 + eps), axis=-1)
    if np.any(bad):
        sub = lab[bad]
        lo, hi = np.zeros(len(sub)), np.ones(len(sub))
        for _ in range(iters):
            mid = (lo + hi) / 2
            t = sub.copy()
            t[:, 1:] *= mid[:, None]
            r = oklab_to_linear(t)
            ok = np.all((r >= -eps) & (r <= 1 + eps), axis=-1)
            lo = np.where(ok, mid, lo)
            hi = np.where(ok, hi, mid)
        sub[:, 1:] *= lo[:, None]
        rgb[bad] = oklab_to_linear(sub)
    return np.clip(rgb, 0.0, 1.0)


# palette parsing

_TOKEN = re.compile(r"^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?::([0-9]*\.?[0-9]+))?$")


def parse_palette(text):
    """'#rrggbb[:w], ...' -> (colors (K,3) sRGB 0..1, weights (K,) summing to 1). Empty text -> (None, None)."""
    s = str(text or "").strip()
    if not s:
        return None, None
    if s.startswith("["):
        items = json.loads(s)
        if not isinstance(items, list):
            raise ValueError("palette: JSON form must be a list")
        toks = []
        for it in items:
            if isinstance(it, dict):
                toks.append(f"{it.get('hex', '')}:{it.get('weight', 1)}")
            else:
                toks.append(str(it))
    else:
        toks = [t for t in re.split(r"[\s,;]+", s) if t]
    cols, ws = [], []
    for t in toks:
        m = _TOKEN.match(t)
        if not m:
            raise ValueError(f"palette: '{t}' is not a #rrggbb colour")
        h = m.group(1)
        if len(h) == 3:
            h = "".join(ch * 2 for ch in h)
        cols.append([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])
        w = float(m.group(2)) if m.group(2) else 1.0
        if not math.isfinite(w) or w <= 0:
            raise ValueError(f"palette: weight of '{t}' must be > 0")
        ws.append(w)
    if not cols:
        raise ValueError("palette: no colours")
    if len(cols) > MAX_COLORS:
        raise ValueError(f"palette: at most {MAX_COLORS} colours")
    w = np.array(ws, np.float64)
    return np.array(cols, np.float64), w / w.sum()


# fitting


def _sym_pow(c, p, floor=1e-8):
    c = (c + c.T) / 2
    vals, vecs = np.linalg.eigh(c)
    vals = np.maximum(vals, floor)
    return (vecs * vals ** p) @ vecs.T


def lab_stats(lab):
    x = np.asarray(lab, np.float64).reshape(-1, 3)
    mu = x.mean(axis=0)
    d = x - mu
    return mu, d.T @ d / max(1, len(x) - 1)


def mkl_transform(cs, ct):
    """Monge-Kantorovich linear map A (symmetric) with A cs A = ct, eigenvalues clamped to GAIN_MIN..GAIN_MAX."""
    reg = np.diag([1e-4, 4e-5, 4e-5])  # floor so a flat (grey / single-colour) clip does not explode
    cs = cs + reg
    ct = ct + reg
    s_half = _sym_pow(cs, 0.5)
    s_inv_half = _sym_pow(cs, -0.5)
    a = s_inv_half @ _sym_pow(s_half @ ct @ s_half, 0.5) @ s_inv_half
    a = (a + a.T) / 2
    vals, vecs = np.linalg.eigh(a)
    return (vecs * np.clip(vals, GAIN_MIN, GAIN_MAX)) @ vecs.T


def palette_target(pal_lab, weights, cs):
    """Target (mean, cov) of a palette: weighted swatch mixture with PALETTE_SPREAD, part of the clip's cov kept."""
    mu = weights @ pal_lab
    d = pal_lab - mu
    ct = (d * weights[:, None]).T @ d + np.diag(PALETTE_SPREAD ** 2)
    return mu, (1 - PALETTE_COV_KEEP) * ct + PALETTE_COV_KEEP * cs


def skin_mask(lab):
    """0..1 membership of the skin-tone band (OKLab hue ~25..75 deg, low-mid chroma, mid lightness)."""
    lab = np.asarray(lab, np.float64)
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    c = np.hypot(a, b)
    h = np.degrees(np.arctan2(b, a))

    def ramp(x, x0, x1):
        return np.clip((x - x0) / (x1 - x0), 0.0, 1.0)

    hue = ramp(h, 15, 35) * (1 - ramp(h, 68, 80))  # skin sits at ~45..60 deg; saturated yellows at 80+
    chroma = ramp(c, 0.015, 0.035) * (1 - ramp(c, 0.12, 0.17))
    light = ramp(L, 0.2, 0.32) * (1 - ramp(L, 0.93, 0.98))
    return hue * chroma * light


class Grade:
    """A fitted, frame-independent grade: OKLab affine (+ optional palette pull) and the knobs that shape it."""

    def __init__(self, src_mu, a, tgt_mu, pal_lab=None, pal_w=None, strength=1.0, preserve_luminance=False,
                 skin_protect=0.0):
        self.src_mu, self.a, self.tgt_mu = src_mu, a, tgt_mu
        self.pal_lab, self.pal_w = pal_lab, pal_w
        self.strength = float(min(max(strength, 0.0), 1.0))
        self.preserve_luminance = bool(preserve_luminance)
        self.skin_protect = float(min(max(skin_protect, 0.0), 1.0))

    def map_lab(self, lab):
        """Full-strength target OKLab for source OKLab colours (..., 3)."""
        out = (lab - self.src_mu) @ self.a.T + self.tgt_mu
        if self.pal_lab is not None:
            d = out[..., None, :] - self.pal_lab  # (..., K, 3)
            dist2 = 0.25 * d[..., 0] ** 2 + d[..., 1] ** 2 + d[..., 2] ** 2
            logits = np.log(self.pal_w) - dist2 / (2 * PULL_TAU ** 2)
            logits -= logits.max(axis=-1, keepdims=True)
            w = np.exp(logits)
            w /= w.sum(axis=-1, keepdims=True)
            near = w @ self.pal_lab
            out = out.copy()
            out[..., 1:] += PULL_AB * (near[..., 1:] - out[..., 1:])
            out[..., 0] += PULL_L * (near[..., 0] - out[..., 0])
        if self.preserve_luminance:
            out = out.copy()
            out[..., 0] = lab[..., 0]
        return out

    def apply_srgb(self, srgb):
        """Graded sRGB 0..1 for source sRGB 0..1 (..., 3) — the exact function baked into the LUT."""
        srgb = np.asarray(srgb, np.float64)
        lab = srgb_to_oklab(srgb)
        mapped = oklab_to_srgb(self.map_lab(lab))
        s = self.strength
        if self.skin_protect > 0:
            s = s * (1 - self.skin_protect * skin_mask(lab))[..., None]
        return srgb + s * (mapped - srgb)

    def lut(self, size=LUT_SIZE):
        """(size, size, size, 3) float LUT indexed [r, g, b] over 0..1 sRGB."""
        g = np.linspace(0.0, 1.0, size)
        grid = np.stack(np.meshgrid(g, g, g, indexing="ij"), axis=-1)
        return np.clip(self.apply_srgb(grid), 0.0, 1.0)


def fit_grade(src_rgb, target_rgb=None, palette=None, strength=0.8, preserve_luminance=False, skin_protect=0.0):
    """Fit ONE grade from sampled source pixels (uint8 or 0..1, (..., 3)) to a reference image's pixels or to a
    palette (colors, weights) from parse_palette. Called once per clip, never per frame."""
    src = _unit(src_rgb)
    src_lab = srgb_to_oklab(src.reshape(-1, 3))
    smu, scov = lab_stats(src_lab)
    if palette is not None and palette[0] is not None:
        cols, w = palette
        pal_lab = srgb_to_oklab(cols)
        tmu, tcov = palette_target(pal_lab, w, scov)
        return Grade(smu, mkl_transform(scov, tcov), tmu, pal_lab, w, strength, preserve_luminance, skin_protect)
    if target_rgb is None:
        raise ValueError("CJVideoPalette: give a palette or a reference image")
    tmu, tcov = lab_stats(srgb_to_oklab(_unit(target_rgb).reshape(-1, 3)))
    tcov = (1 - REFERENCE_COV_KEEP) * tcov + REFERENCE_COV_KEEP * scov
    return Grade(smu, mkl_transform(scov, tcov), tmu, None, None, strength, preserve_luminance, skin_protect)


def _unit(x):
    x = np.asarray(x)
    return x.astype(np.float64) / 255.0 if x.dtype == np.uint8 else x.astype(np.float64)


# LUT bake / apply / export


def _interp_matrix(n_out, n_grid):
    """(n_out, n_grid) linear-interpolation weights from grid samples to byte values 0..255."""
    x = np.arange(n_out) / (n_out - 1) * (n_grid - 1)
    i0 = np.minimum(np.floor(x).astype(int), n_grid - 2)
    f = x - i0
    m = np.zeros((n_out, n_grid))
    m[np.arange(n_out), i0] = 1 - f
    m[np.arange(n_out), i0 + 1] = f
    return m


def expand_lut(lut):
    """33^3 float LUT -> (256^3,) uint32 table of packed RGB0 bytes indexed (r<<16)|(g<<8)|b.
    Separable linear interpolation along r, g, b == exact trilinear interpolation of the cube."""
    n = lut.shape[0]
    m = _interp_matrix(256, n)
    t = np.tensordot(m, lut, axes=(1, 0))                       # (256r, n, n, 3)
    t = np.tensordot(m, t, axes=(1, 1)).transpose(1, 0, 2, 3)  # (256r, 256g, n, 3)
    out = np.zeros((256, 256, 256, 4), np.uint8)
    for r0 in range(0, 256, 32):                                # b axis in chunks: ~400 MB float peak
        blk = np.matmul(m, t[r0:r0 + 32])                       # (32, 256g, 256b, 3)
        out[r0:r0 + 32, ..., :3] = np.clip(np.rint(blk * 255.0), 0, 255).astype(np.uint8)
    return out.reshape(-1, 4).view(np.uint32).ravel()


def apply_table(frame, table):
    """(H, W, 3) uint8 frame -> graded uint8 frame via the 256^3 table (pure per-pixel lookup)."""
    f = frame.astype(np.uint32)
    idx = (f[..., 0] << 16) | (f[..., 1] << 8) | f[..., 2]
    return np.ascontiguousarray(table[idx].view(np.uint8).reshape(frame.shape[0], frame.shape[1], 4)[..., :3])


def cube_text(lut, title="Adrift Video Color Palette"):
    """Adobe/Resolve .cube text: red varies fastest."""
    n = lut.shape[0]
    rows = lut.transpose(2, 1, 0, 3).reshape(-1, 3)  # [b][g][r] order
    lines = [f'TITLE "{title}"', f"LUT_3D_SIZE {n}", "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0"]
    lines += [f"{r:.6f} {g:.6f} {b:.6f}" for r, g, b in rows]
    return "\n".join(lines) + "\n"


def parse_cube(text):
    """Parse a .cube back into an (n, n, n, 3) array indexed [r, g, b] (for tests / round-trips)."""
    n, vals = None, []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("TITLE") or line.startswith("DOMAIN_"):
            continue
        if line.startswith("LUT_3D_SIZE"):
            n = int(line.split()[1])
            continue
        vals.append([float(v) for v in line.split()])
    if n is None or len(vals) != n ** 3:
        raise ValueError("cube: size header missing or wrong number of rows")
    return np.array(vals).reshape(n, n, n, 3).transpose(2, 1, 0, 3)


# ffmpeg I/O


def _rate(s):
    try:
        a, _, b = str(s).partition("/")
        v = float(a) / float(b or 1)
        return v if math.isfinite(v) and v > 0 else None
    except (ValueError, ZeroDivisionError):
        return None


def probe(path):
    """{width, height (display, even), fps, fps_str, duration} of the first video stream."""
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-print_format", "json",
                        "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation"
                        ":stream_tags=rotate:format=duration", path], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {r.stderr.decode(errors='replace')[-300:]}")
    info = json.loads(r.stdout or b"{}")
    streams = info.get("streams") or []
    if not streams:
        raise RuntimeError("the source has no video stream")
    st = streams[0]
    w, h = int(st.get("width") or 0), int(st.get("height") or 0)
    if w < 2 or h < 2:
        raise RuntimeError("could not read the video size")
    rot = 0
    for sd in st.get("side_data_list") or []:
        if "rotation" in sd:
            rot = int(float(sd["rotation"]))
    if not rot and (st.get("tags") or {}).get("rotate"):
        rot = int(float(st["tags"]["rotate"]))
    if abs(rot) % 180 == 90:
        w, h = h, w
    fps_str = st.get("avg_frame_rate") or ""
    fps = _rate(fps_str)
    if fps is None:
        fps_str = st.get("r_frame_rate") or "24/1"
        fps = _rate(fps_str) or 24.0
    if fps > MAX_FPS:
        fps, fps_str = MAX_FPS, str(int(MAX_FPS))
    try:
        dur = float((info.get("format") or {}).get("duration") or 0)
    except ValueError:
        dur = 0.0
    return {"width": w // 2 * 2, "height": h // 2 * 2, "fps": fps, "fps_str": fps_str,
            "duration": dur if math.isfinite(dur) and dur > 0 else None}


def _decode_raw(cmd, w, h):
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg could not decode: {r.stderr.decode(errors='replace')[-400:]}")
    n = len(r.stdout) // (w * h * 3)
    if n < 1:
        raise RuntimeError("no frames decoded")
    return np.frombuffer(r.stdout, np.uint8, count=n * w * h * 3).reshape(n, h, w, 3)


def _analysis_size(w, h, width=ANALYSIS_WIDTH):
    aw = min(width, w) // 2 * 2
    return aw, max(2, int(round(h * aw / w)) // 2 * 2)


def sample_frames(path, info, n=DEFAULT_SAMPLES):
    """~n frames spread evenly over the clip, at analysis size (for the one-time fit)."""
    aw, ah = _analysis_size(info["width"], info["height"])
    rate = n / info["duration"] if info["duration"] else 1.0
    rate = min(max(rate, 0.05), info["fps"])
    vf = f"fps={rate:.6f},scale={aw}:{ah}:flags=area,setsar=1"
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-map", "0:v:0", "-vf", vf, "-frames:v", str(n),
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    return _decode_raw(cmd, aw, ah)


def load_reference(path):
    """Reference still (first frame of any image/video) at analysis size, (h, w, 3) uint8."""
    info = probe(path)
    aw, ah = _analysis_size(info["width"], info["height"])
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-map", "0:v:0", "-frames:v", "1",
           "-vf", f"scale={aw}:{ah}:flags=area,setsar=1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    return _decode_raw(cmd, aw, ah)[0]


def render(src_path, grade, out_path, crf=18, preset="medium", info=None):
    """Stream-decode src, apply the baked grade per frame, encode H.264 + source audio. Returns (frames, lut)."""
    info = info or probe(src_path)
    w, h = info["width"], info["height"]
    lut = grade.lut()
    table = expand_lut(lut)
    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-nostdin", "-i", src_path, "-map", "0:v:0",
                            "-vf", f"fps={info['fps_str']},crop={w}:{h}:0:0,setsar=1,{RGB_DECODE_VF}",
                            "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
                            "-s", f"{w}x{h}", "-r", info["fps_str"], "-i", "-", "-i", src_path,
                            "-map", "0:v:0", "-map", "1:a:0?", "-c:a", "aac", "-b:a", "192k",
                            "-vf", BT709_ENCODE_VF, "-c:v", "libx264", "-preset", preset, "-crf", str(int(crf)), "-pix_fmt", "yuv420p",
                            "-movflags", "+faststart", out_path], stdin=subprocess.PIPE)
    size = w * h * 3
    n = 0
    try:
        while True:
            buf = dec.stdout.read(size)
            if len(buf) < size:
                break
            frame = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            enc.stdin.write(apply_table(frame, table).tobytes())
            n += 1
    except BrokenPipeError:
        pass
    finally:
        dec.stdout.close()
        dec_rc = dec.wait()
        try:
            enc.stdin.close()
        except BrokenPipeError:
            pass
        enc_rc = enc.wait()
    if dec_rc != 0 or n == 0:
        raise RuntimeError(f"ffmpeg could not decode the source video ({n} frames)")
    if enc_rc != 0:
        raise RuntimeError(f"ffmpeg encode failed for {out_path}")
    return n, lut


def grade_video(src_path, out_path, reference_path=None, palette=None, strength=0.8, preserve_luminance=False,
                skin_protect=0.0, samples=DEFAULT_SAMPLES, crf=18, cube_path=None):
    """Fit once + render. Returns frames written. Writes the LUT as .cube to cube_path when given."""
    pal = parse_palette(palette)
    if pal[0] is None and not reference_path:
        raise ValueError("CJVideoPalette: give a palette or a reference image")
    info = probe(src_path)
    sample = sample_frames(src_path, info, samples)
    target = None if pal[0] is not None else load_reference(reference_path)
    grade = fit_grade(sample, target, pal if pal[0] is not None else None, strength, preserve_luminance,
                      skin_protect)
    n, lut = render(src_path, grade, out_path, crf=crf, info=info)
    if cube_path:
        with open(cube_path, "w", encoding="ascii") as f:
            f.write(cube_text(lut))
    return n


# ComfyUI node


def _resolve(ref, what):
    """ComfyUI annotated ref ("name.mp4 [input]" / "video/x.mp4 [output]") -> existing path inside its folder."""
    import folder_paths
    ref = str(ref or "").strip()
    if not ref:
        raise ValueError(f"CJVideoPalette: {what} is empty")
    path = os.path.realpath(folder_paths.get_annotated_filepath(ref))
    roots = [os.path.realpath(d) for d in (folder_paths.get_input_directory(), folder_paths.get_output_directory(),
                                           folder_paths.get_temp_directory())]
    if not any(path == r or path.startswith(r + os.sep) for r in roots):
        raise ValueError(f"CJVideoPalette: {what} must be inside ComfyUI input/output/temp")
    if not os.path.isfile(path):
        raise FileNotFoundError(f"CJVideoPalette: {what} not found: {ref}")
    return path


class CJVideoPalette:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "video": ("STRING", {"default": "", "tooltip": "Source clip ref, e.g. 'clip.mp4 [input]'."}),
            "reference": ("STRING", {"default": "", "tooltip": "Reference still ref (used when palette is empty)."}),
            "palette": ("STRING", {"default": "", "tooltip": "Hex colours '#rrggbb[:weight], ...' (wins over reference)."}),
            "strength": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 1.0, "step": 0.01}),
            "preserve_luminance": ("BOOLEAN", {"default": False, "tooltip": "Keep the source's OKLab lightness."}),
            "skin_protect": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01,
                                       "tooltip": "Fade the grade on skin-tone colours (0 = off)."}),
            "filename_prefix": ("STRING", {"default": "video/adrift_palette"}),
        }, "optional": {
            "crf": ("INT", {"default": 18, "min": 0, "max": 51}),
            "sample_frames": ("INT", {"default": DEFAULT_SAMPLES, "min": 4, "max": 120}),
        }}

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("path", "cube_path")
    OUTPUT_NODE = True
    FUNCTION = "run"
    CATEGORY = "image/video"

    def run(self, video, reference, palette, strength, preserve_luminance, skin_protect, filename_prefix, crf=18,
            sample_frames=DEFAULT_SAMPLES):
        import folder_paths
        pal = parse_palette(palette)  # fail fast before decoding
        src = _resolve(video, "video")
        ref = None if pal[0] is not None else _resolve(reference, "reference")
        full, name, counter, sub, _ = folder_paths.get_save_image_path(filename_prefix,
                                                                       folder_paths.get_output_directory())
        os.makedirs(full, exist_ok=True)
        fname = f"{name}_{counter:05}_.mp4"
        out = os.path.join(full, fname)
        cube = os.path.join(full, f"{name}_{counter:05}_.cube")
        grade_video(src, out, reference_path=ref, palette=palette, strength=strength,
                    preserve_luminance=preserve_luminance, skin_protect=skin_protect, samples=sample_frames,
                    crf=crf, cube_path=cube)
        return {"ui": {"images": [{"filename": fname, "subfolder": sub, "type": "output"}], "animated": (True,)},
                "result": (out, cube)}


NODE_CLASS_MAPPINGS = {"CJVideoPalette": CJVideoPalette}
NODE_DISPLAY_NAME_MAPPINGS = {"CJVideoPalette": "Video Color Palette (one-fit LUT regrade, .cube export)"}

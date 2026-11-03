"""CJGridVideo: beat-synced grid music video from one source clip (or still) + a music track.

The Adrift builder (src/lib/oj/gridVideo.ts) computes the whole edit as a JSON plan (segments cut on the
beats, per-segment grid, per-tile source offset / speed / zoom / crop / mirror / effect / flash); this node
only renders it: ffmpeg decodes the source once at the output size (cover crop, plan fps), numpy composites
every output frame from a box-filtered mip pyramid (nearest / bilinear gather per tile, cheap LUT effects),
and ffmpeg encodes H.264 with the music muxed as AAC. CPU only, numpy + ffmpeg, no models.

Plan (v1): {"v":1, "width","height","fps","frames","srcFrames","still","bg":"#rrggbb",
            "fx":[{"k":"duotone","a":"#..","b":"#.."}|{"k":"posterize","n":3}|{"k":"invert"}|
                  {"k":"halftone","ink":"#..","paper":"#.."}|{"k":"mono","contrast":1.7}|{"k":"solarize"}|
                  {"k":"rgbsplit","px":8}|{"k":"swap"}, ...],
            "segments":[{"f0","f1","rows","cols","gap","pulse",
                         "tiles":[[offset, speed, zoom0, zoom1, cx, cy, mirror, fx_index|-1, flash], ...]}]}
The source loops ping-pong (forward, then backward) to fill the music.
"""
import json
import math
import os
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

MAX_SIDE = 2160
MAX_FRAMES = 30 * 600
MAX_GRID = 12
#: decoded source budget (all frames sit in RAM, plus ~1/3 for the mip pyramid)
MAX_SOURCE_BYTES = 1_600_000_000
MIP_LEVELS = 4
FLASH_TAU_S = 0.06
PULSE_TAU_S = 0.10
EFFECTS = ("duotone", "posterize", "invert", "halftone", "mono", "solarize", "rgbsplit", "swap")


def hex_rgb(s, fallback=(0, 0, 0)):
    s = str(s or "").lstrip("#")
    if len(s) != 6:
        return np.array(fallback, np.float32)
    try:
        return np.array([int(s[i:i + 2], 16) for i in (0, 2, 4)], np.float32)
    except ValueError:
        return np.array(fallback, np.float32)


def _int(v, lo, hi, what):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ValueError(f"grid plan: {what} must be a number")
    v = int(round(v))
    if v < lo or v > hi:
        raise ValueError(f"grid plan: {what}={v} outside {lo}..{hi}")
    return v


def parse_plan(plan):
    """Validate a plan (JSON string or dict); returns a normalized dict with numpy tile arrays."""
    p = json.loads(plan) if isinstance(plan, str) else plan
    if not isinstance(p, dict) or p.get("v") != 1:
        raise ValueError("grid plan: expected a v1 plan object")
    w = _int(p.get("width"), 16, MAX_SIDE, "width")
    h = _int(p.get("height"), 16, MAX_SIDE, "height")
    if w % 2 or h % 2:
        raise ValueError("grid plan: width/height must be even")
    fps = _int(p.get("fps"), 1, 60, "fps")
    frames = _int(p.get("frames"), 1, MAX_FRAMES, "frames")
    src_frames = _int(p.get("srcFrames", 1), 1, MAX_FRAMES, "srcFrames")
    fx = p.get("fx") or []
    if not isinstance(fx, list) or any(not isinstance(e, dict) or e.get("k") not in EFFECTS for e in fx):
        raise ValueError(f"grid plan: fx entries must be one of {EFFECTS}")
    segs = p.get("segments")
    if not isinstance(segs, list) or not segs:
        raise ValueError("grid plan: no segments")
    out, expect = [], 0
    for i, s in enumerate(segs):
        f0 = _int(s.get("f0"), 0, frames, f"segments[{i}].f0")
        f1 = _int(s.get("f1"), 0, frames, f"segments[{i}].f1")
        if f0 != expect or f1 <= f0:
            raise ValueError(f"grid plan: segments[{i}] must start at frame {expect} and be non-empty")
        expect = f1
        rows = _int(s.get("rows"), 1, MAX_GRID * 2, f"segments[{i}].rows")
        cols = _int(s.get("cols"), 1, MAX_GRID, f"segments[{i}].cols")
        tiles = np.asarray(s.get("tiles"), dtype=np.float64)
        if tiles.shape != (rows * cols, 9) or not np.all(np.isfinite(tiles)):
            raise ValueError(f"grid plan: segments[{i}].tiles must be {rows * cols} rows of 9 numbers")
        if np.any(tiles[:, 7] >= len(fx)) or np.any(tiles[:, 7] < -1):
            raise ValueError(f"grid plan: segments[{i}] references an unknown effect")
        if np.any(tiles[:, 2:4] < 0.5) or np.any(tiles[:, 2:4] > 8):
            raise ValueError(f"grid plan: segments[{i}] zoom outside 0.5..8")
        out.append({"f0": f0, "f1": f1, "rows": rows, "cols": cols,
                    "gap": _int(s.get("gap", 0), 0, min(w, h) // 4, f"segments[{i}].gap"),
                    "pulse": float(min(max(float(s.get("pulse", 0) or 0), 0.0), 0.5)), "tiles": tiles})
    if expect != frames:
        raise ValueError(f"grid plan: segments end at frame {expect}, plan has {frames}")
    return {"width": w, "height": h, "fps": fps, "frames": frames, "srcFrames": src_frames,
            "still": bool(p.get("still")), "bg": hex_rgb(p.get("bg")).astype(np.uint8), "fx": fx, "segments": out}


# decode


def decode_size(w, h, n):
    """Decode size for n source frames within MAX_SOURCE_BYTES (output size, scaled down if needed)."""
    k = min(1.0, math.sqrt(MAX_SOURCE_BYTES / max(1, n * w * h * 3 * 4 / 3)))
    return max(16, int(w * k) // 2 * 2), max(16, int(h * k) // 2 * 2)


def decode_source(path, w, h, fps, max_frames, still=False):
    """(N, h, w, 3) uint8: cover-scaled + centre-cropped to w x h, resampled to fps, at most max_frames."""
    vf = f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=bicubic,crop={w}:{h},setsar=1,{RGB_DECODE_VF}"
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-map", "0:v:0"]
    if still:
        cmd += ["-frames:v", "1", "-vf", vf]
    else:
        cmd += ["-vf", f"fps={fps}," + vf, "-frames:v", str(max_frames)]
    cmd += ["-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg could not decode the source: {r.stderr.decode(errors='replace')[-400:]}")
    n = len(r.stdout) // (w * h * 3)
    if n < 1:
        raise RuntimeError("the source has no video frames")
    return np.frombuffer(r.stdout, np.uint8, count=n * w * h * 3).reshape(n, h, w, 3)


def mip_pyramid(frames, levels=MIP_LEVELS):
    """[level0, level1, ...]: each level a 2x2 box average of the previous (anti-aliased small tiles)."""
    pyr = [frames]
    for _ in range(levels - 1):
        a = pyr[-1]
        hh, ww = a.shape[1] // 2 * 2, a.shape[2] // 2 * 2
        if hh < 8 or ww < 8:
            break
        a = a[:, :hh, :ww].astype(np.uint16)
        pyr.append(((a[:, 0::2, 0::2] + a[:, 1::2, 0::2] + a[:, 0::2, 1::2] + a[:, 1::2, 1::2] + 2) >> 2)
                   .astype(np.uint8))
    return pyr


# sampling + effects


def pingpong(i, n):
    if n <= 1:
        return 0
    period = 2 * n - 2
    k = int(i) % period
    return k if k < n else period - k


def tile_window(sw, sh, tw, th, zoom, cx, cy):
    """Source window (x0, y0, ww, wh) in level-0 pixels: tile aspect cover fit, / zoom, centred on cx, cy."""
    if tw / th >= sw / sh:
        ww, wh = float(sw), sw * th / tw
    else:
        ww, wh = sh * tw / th, float(sh)
    ww, wh = ww / zoom, wh / zoom
    x0 = min(max(cx * sw - ww / 2, 0.0), max(0.0, sw - ww))
    y0 = min(max(cy * sh - wh / 2, 0.0), max(0.0, sh - wh))
    return x0, y0, ww, wh


def sample_tile(pyr, idx, tw, th, zoom, cx, cy, mirror=False):
    """(th, tw, 3) uint8 view of source frame idx: mip level by scale, nearest when shrinking, bilinear when enlarging."""
    sh, sw = pyr[0].shape[1:3]
    x0, y0, ww, wh = tile_window(sw, sh, tw, th, zoom, cx, cy)
    scale = ww / tw
    lvl = 0
    while lvl + 1 < len(pyr) and scale >= 2 ** (lvl + 1):
        lvl += 1
    f = float(2 ** lvl)
    a = pyr[lvl][idx]
    hl, wl = a.shape[:2]
    xs = (x0 + (np.arange(tw) + 0.5) * (ww / tw)) / f - 0.5
    ys = (y0 + (np.arange(th) + 0.5) * (wh / th)) / f - 0.5
    if mirror:
        xs = xs[::-1]
    if scale >= 0.999:
        xi = np.clip(np.rint(xs).astype(np.int32), 0, wl - 1)
        yi = np.clip(np.rint(ys).astype(np.int32), 0, hl - 1)
        return a[yi[:, None], xi[None, :]]
    xf, yf = np.floor(xs), np.floor(ys)
    ax = (xs - xf).astype(np.float32)[None, :, None]
    ay = (ys - yf).astype(np.float32)[:, None, None]
    x0i = np.clip(xf.astype(np.int32), 0, wl - 1)
    x1i = np.clip(x0i + 1, 0, wl - 1)
    y0i = np.clip(yf.astype(np.int32), 0, hl - 1)
    y1i = np.clip(y0i + 1, 0, hl - 1)
    r0 = a[y0i[:, None], x0i[None, :]] * (1 - ax) + a[y0i[:, None], x1i[None, :]] * ax
    r1 = a[y1i[:, None], x0i[None, :]] * (1 - ax) + a[y1i[:, None], x1i[None, :]] * ax
    return np.clip(r0 * (1 - ay) + r1 * ay + 0.5, 0, 255).astype(np.uint8)


def luma(t):
    t16 = t.astype(np.uint16)
    return ((t16[..., 0] * 77 + t16[..., 1] * 150 + t16[..., 2] * 29) >> 8).astype(np.uint8)


_RAMP = np.arange(256, dtype=np.float32) / 255.0


def apply_effect(t, e):
    """Effect e (plan fx entry) on tile t (h, w, 3) uint8 -> new uint8 tile."""
    k = e.get("k")
    if k == "invert":
        return 255 - t
    if k == "duotone":
        a, b = hex_rgb(e.get("a"), (0, 0, 0)), hex_rgb(e.get("b"), (255, 255, 255))
        lut = (a[None, :] + (b - a)[None, :] * _RAMP[:, None] + 0.5).astype(np.uint8)
        return lut[luma(t)]
    if k == "posterize":
        n = int(min(max(int(e.get("n", 3)), 2), 16))
        lut = (np.round(np.round(_RAMP * (n - 1)) * (255.0 / (n - 1)))).astype(np.uint8)
        return lut[t]
    if k == "mono":
        c = float(min(max(float(e.get("contrast", 1.5)), 0.2), 4.0))
        lut = np.clip((np.arange(256) - 128.0) * c + 128.0, 0, 255).astype(np.uint8)
        return np.repeat(lut[luma(t)][..., None], 3, axis=2)
    if k == "solarize":
        lut = np.where(np.arange(256) < 128, np.arange(256), 255 - np.arange(256)).astype(np.uint8)
        return lut[t]
    if k == "swap":
        return t[..., [2, 0, 1]]
    if k == "rgbsplit":
        px = max(1, int(round(float(e.get("px", 8)) * t.shape[1] / 360.0)))
        out = t.copy()
        out[..., 0] = np.roll(t[..., 0], -px, axis=1)
        out[..., 2] = np.roll(t[..., 2], px, axis=1)
        return out
    if k == "halftone":
        return halftone(t, hex_rgb(e.get("ink"), (17, 17, 17)), hex_rgb(e.get("paper"), (242, 234, 216)))
    return t


def halftone(t, ink, paper):
    """Round-dot screen: dot radius from each cell's mean darkness, 1 px anti-aliased edge."""
    h, w = t.shape[:2]
    c = max(5, int(round(min(h, w) / 16.0)))
    hb, wb = -(-h // c), -(-w // c)
    lum = np.zeros((hb * c, wb * c), np.float32)
    lum[:h, :w] = luma(t)
    if hb * c > h:
        lum[h:, :w] = lum[h - 1:h, :w]
    if wb * c > w:
        lum[:, w:] = lum[:, w - 1:w]
    cell = lum.reshape(hb, c, wb, c).mean(axis=(1, 3))
    radius = np.sqrt(1.0 - cell / 255.0) * c * 0.72
    rad = np.repeat(np.repeat(radius, c, axis=0), c, axis=1)[:h, :w]
    yy = (np.arange(h) % c + 0.5 - c / 2.0)[:, None]
    xx = (np.arange(w) % c + 0.5 - c / 2.0)[None, :]
    d = np.sqrt(yy * yy + xx * xx)
    alpha = np.clip(rad - d + 0.5, 0.0, 1.0)[..., None]
    return (paper * (1 - alpha) + ink * alpha + 0.5).astype(np.uint8)


def flash(t, a):
    if a <= 0.004:
        return t
    return (t * (1.0 - a) + 255.0 * a + 0.5).astype(np.uint8)


# render


def edges(n, size, gap):
    e = np.rint(np.linspace(gap / 2.0, size - gap / 2.0, n + 1)).astype(int)
    return [(int(e[i] + (gap + 1) // 2 if gap else e[i]), int(e[i + 1] - gap // 2 if gap else e[i + 1]))
            for i in range(n)]


def render_frames(pyr, plan):
    """Yield every output frame (H, W, 3) uint8 of the plan from the source pyramid."""
    w, h, fps = plan["width"], plan["height"], plan["fps"]
    n_src = pyr[0].shape[0]
    fx = plan["fx"]
    canvas = np.empty((h, w, 3), np.uint8)
    for seg in plan["segments"]:
        rows, cols, gap = seg["rows"], seg["cols"], seg["gap"]
        xe, ye = edges(cols, w, gap), edges(rows, h, gap)
        n_seg = seg["f1"] - seg["f0"]
        for k in range(n_seg):
            canvas[:] = plan["bg"]
            prog = k / max(1, n_seg - 1)
            punch = 1.0 + seg["pulse"] * math.exp(-k / (PULSE_TAU_S * fps))
            fl_decay = math.exp(-k / (FLASH_TAU_S * fps))
            for ti, (o, s, z0, z1, cx, cy, m, fxi, fl) in enumerate(seg["tiles"]):
                (x0, x1), (y0, y1) = xe[ti % cols], ye[ti // cols]
                tw, th = x1 - x0, y1 - y0
                if tw < 1 or th < 1:
                    continue
                idx = pingpong(math.floor(o + s * k), n_src)
                zoom = (z0 + (z1 - z0) * prog) * punch
                t = sample_tile(pyr, idx, tw, th, zoom, cx, cy, m >= 0.5)
                if fxi >= 0:
                    t = apply_effect(t, fx[int(fxi)])
                t = flash(t, fl * fl_decay)
                canvas[y0:y1, x0:x1] = t
            yield canvas


def render_grid_video(source_path, audio_path, plan, out_path, crf=18, preset="medium"):
    """Render plan (str/dict) to out_path (H.264 + AAC MP4, music trimmed to the video). Returns frames written."""
    p = parse_plan(plan)
    w, h, fps = p["width"], p["height"], p["fps"]
    n_src = 1 if p["still"] else p["srcFrames"]
    dw, dh = decode_size(w, h, n_src)
    pyr = mip_pyramid(decode_source(source_path, dw, dh, fps, n_src, still=p["still"]))
    seconds = p["frames"] / fps
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
           "-r", str(fps), "-i", "-"]
    if audio_path:
        cmd += ["-i", audio_path, "-map", "0:v:0", "-map", "1:a:0?", "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-vf", BT709_ENCODE_VF, "-c:v", "libx264", "-preset", preset, "-crf", str(int(crf)), "-pix_fmt", "yuv420p",
            "-t", f"{seconds:.3f}", "-movflags", "+faststart", out_path]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    n = 0
    try:
        for frame in render_frames(pyr, p):
            enc.stdin.write(frame.tobytes())
            n += 1
    except BrokenPipeError:
        pass
    finally:
        try:
            enc.stdin.close()
        except BrokenPipeError:
            pass
        if enc.wait() != 0:
            raise RuntimeError(f"ffmpeg encode failed for {out_path}")
    return n


# ComfyUI node


def _resolve(ref, what):
    """ComfyUI annotated ref ("name.mp4 [input]" / "video/x.mp4 [output]") -> existing path inside its folder."""
    import folder_paths
    ref = str(ref or "").strip()
    if not ref:
        raise ValueError(f"CJGridVideo: {what} is empty")
    path = os.path.realpath(folder_paths.get_annotated_filepath(ref))
    roots = [os.path.realpath(d) for d in (folder_paths.get_input_directory(), folder_paths.get_output_directory(),
                                           folder_paths.get_temp_directory())]
    if not any(path == r or path.startswith(r + os.sep) for r in roots):
        raise ValueError(f"CJGridVideo: {what} must be inside ComfyUI input/output/temp")
    if not os.path.isfile(path):
        raise FileNotFoundError(f"CJGridVideo: {what} not found: {ref}")
    return path


class CJGridVideo:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "source": ("STRING", {"default": "", "tooltip": "Source clip or image ref, e.g. 'clip.mp4 [input]'."}),
            "audio": ("STRING", {"default": "", "tooltip": "Music ref; the video is as long as the plan (= the music)."}),
            "plan": ("STRING", {"default": "", "multiline": True,
                                "tooltip": "Grid plan JSON (Adrift src/lib/tools/gridVideo.ts planGridVideo)."}),
            "filename_prefix": ("STRING", {"default": "video/adrift_grid"}),
        }, "optional": {
            "crf": ("INT", {"default": 18, "min": 0, "max": 51}),
        }}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("path",)
    OUTPUT_NODE = True
    FUNCTION = "run"
    CATEGORY = "image/video"

    def run(self, source, audio, plan, filename_prefix, crf=18):
        import folder_paths
        parse_plan(plan)  # fail fast before decoding
        src = _resolve(source, "source")
        aud = _resolve(audio, "audio") if str(audio or "").strip() else None
        full, name, counter, sub, _ = folder_paths.get_save_image_path(filename_prefix,
                                                                       folder_paths.get_output_directory())
        os.makedirs(full, exist_ok=True)
        fname = f"{name}_{counter:05}_.mp4"
        out = os.path.join(full, fname)
        render_grid_video(src, aud, plan, out, crf=crf)
        return {"ui": {"images": [{"filename": fname, "subfolder": sub, "type": "output"}], "animated": (True,)},
                "result": (out,)}


NODE_CLASS_MAPPINGS = {"CJGridVideo": CJGridVideo}
NODE_DISPLAY_NAME_MAPPINGS = {"CJGridVideo": "Grid Video (beat-synced grid, music soundtrack)"}

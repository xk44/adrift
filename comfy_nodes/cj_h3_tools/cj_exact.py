"""exact-to-source video edits. Every source frame goes through the model 1:1 and comes back at its own timestamp.

The stock H3 prepare resamples to 24 fps and centre-crops to the model grid, and paste-back then writes through an RGB
pipe. This pair keeps the source as the master instead:

  CJExactPrepare   decodes every frame with no fps resample and no crop (a stretch of a few percent reaches the 32 px
                    grid), then repeats the last frame up to the next 17n+5 length.
  CJExactPasteSave composites in the source's own YUV planes, so samples with alpha 0 are copied, not converted. It
                    reuses the source's PTS, time base, colour tags and audio packets.

With `master` on (x264 qp 0) samples outside the edit decode bit-identical. Delivery mode is a lossy encode, so it can't
promise identical samples outside the edit.

Clips above 24 fps look slow-motion to the model: it follows the pose frame by frame and costs more compute."""
import fractions
import json
import logging
import math
import os
import tempfile

import cv2
import numpy as np

_log = logging.getLogger("cj_h3_tools")

PIXEL_BUDGETS = {"480": 500_000, "768": 1_000_000}
MODEL_FPS = 24
MAX_FRAMES = 3592   # largest 17n+5 the H3 nodes accept
ALPHA_EPS = 1 / 512
MP4_AUDIO = {"aac", "mp3", "ac3", "eac3", "alac", "opus", "flac"}

# pix_fmt -> (chroma x shift, chroma y shift, bit depth, forced full range)
NATIVE = {
    "yuv420p": (1, 1, 8, False), "yuvj420p": (1, 1, 8, True), "yuv420p10le": (1, 1, 10, False),
    "yuv422p": (1, 0, 8, False), "yuvj422p": (1, 0, 8, True), "yuv422p10le": (1, 0, 10, False),
    "yuv444p": (0, 0, 8, False), "yuvj444p": (0, 0, 8, True), "yuv444p10le": (0, 0, 10, False),
}
KR_KB = {1: (.2126, .0722), 4: (.30, .11), 5: (.299, .114), 6: (.299, .114), 7: (.212, .087), 9: (.2627, .0593),
         10: (.2627, .0593)}
X264_MATRIX = {1: "bt709", 4: "fcc", 5: "bt470bg", 6: "smpte170m", 7: "smpte240m", 9: "bt2020nc", 10: "bt2020c"}
X264_PRIM = {1: "bt709", 4: "bt470m", 5: "bt470bg", 6: "smpte170m", 7: "smpte240m", 9: "bt2020"}
X264_TRC = {1: "bt709", 4: "bt470m", 5: "bt470bg", 6: "smpte170m", 7: "smpte240m", 8: "linear", 13: "iec61966-2-1",
            14: "bt2020-10", 15: "bt2020-12", 16: "smpte2084", 18: "arib-std-b67"}


def h3_length(count):
    """Smallest 17n+5 that holds count frames."""
    if not 1 <= count <= MAX_FRAMES:
        raise ValueError(f"Video must contain 1-{MAX_FRAMES} frames; got {count}.")
    return 5 + 17 * max(0, (count - 5 + 16) // 17)


def canvas(width, height, resolution):
    """Nearest 32 px grid size inside the pixel budget. The whole frame is resized to it, nothing is cropped."""
    budget = PIXEL_BUDGETS[resolution]
    ideal_w, ideal_h = math.sqrt(budget * width / height), math.sqrt(budget * height / width)
    best = None
    for w in range(32, budget // 32 + 1, 32):
        max_h = budget // w // 32 * 32
        for h in {max(32, min(max_h, int(ideal_h // 32) * 32)), max(32, min(max_h, math.ceil(ideal_h / 32) * 32))}:
            score = math.log(w / ideal_w) ** 2 + math.log(h / ideal_h) ** 2
            if best is None or (score, -(w * h)) < best[0]:
                best = ((score, -(w * h)), w, h)
    return best[1], best[2]


class Colour:
    """Conversion between RGB in 0..1 and YUV code values, using the source's own matrix and range."""

    def __init__(self, frame, fmt, width, height):
        self.depth = fmt[2]
        self.full = fmt[3] or int(getattr(frame, "color_range", 0) or 0) == 2
        self.space = int(getattr(frame, "colorspace", 2) or 2)
        # Untagged: the same guess players make from the size.
        hd = max(width, height) >= 1280 or min(width, height) >= 720
        self.kr, self.kb = KR_KB.get(self.space, KR_KB[1] if hd else KR_KB[6])
        self.top = 2 ** self.depth - 1
        shift = 2 ** (self.depth - 8)
        self.y_off, self.y_gain = (0.0, float(self.top)) if self.full else (16.0 * shift, 219.0 * shift)
        self.c_off, self.c_gain = ((2.0 ** (self.depth - 1), float(self.top)) if self.full
                                   else (128.0 * shift, 224.0 * shift))

    def to_rgb(self, y, u, v):
        """Planes of equal size, returns float32 RGB in 0..1."""
        yy = (y.astype(np.float32) - self.y_off) / self.y_gain
        cb = (u.astype(np.float32) - self.c_off) / self.c_gain
        cr = (v.astype(np.float32) - self.c_off) / self.c_gain
        kr, kb, kg = self.kr, self.kb, 1 - self.kr - self.kb
        r = yy + 2 * (1 - kr) * cr
        b = yy + 2 * (1 - kb) * cb
        g = (yy - kr * r - kb * b) / kg
        return np.clip(np.stack([r, g, b], -1), 0, 1)

    def to_yuv(self, rgb):
        """Float RGB in 0..1, returns float32 Y, U, V code values."""
        kr, kb, kg = self.kr, self.kb, 1 - self.kr - self.kb
        r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
        yy = kr * r + kg * g + kb * b
        return (yy * self.y_gain + self.y_off, (b - yy) / (2 * (1 - kb)) * self.c_gain + self.c_off,
                (r - yy) / (2 * (1 - kr)) * self.c_gain + self.c_off)


def _plane(frame, i, depth):
    p = frame.planes[i]
    dtype = np.uint16 if depth > 8 else np.uint8
    row = p.line_size // (2 if depth > 8 else 1)
    return np.frombuffer(p, dtype=dtype).reshape(-1, row)[:p.height, :p.width]


class Decoded:
    """A frame's planes in display orientation (rotation applied, nothing else touched)."""

    def __init__(self, frame, fmt):
        self.k = int(round(float(getattr(frame, "rotation", 0) or 0) / 90)) % 4
        self.planes = [np.rot90(_plane(frame, i, fmt[2]), self.k) if self.k else _plane(frame, i, fmt[2])
                       for i in range(3)]
        self.h, self.w = self.planes[0].shape

    def rgb(self, colour):
        y, u, v = self.planes
        if u.shape != y.shape:
            u = cv2.resize(u, (self.w, self.h), interpolation=cv2.INTER_LINEAR)
            v = cv2.resize(v, (self.w, self.h), interpolation=cv2.INTER_LINEAR)
        return colour.to_rgb(y, u, v)


def _normalise(frame):
    """Returns (frame, fmt, native). Formats we can't composite natively become 4:4:4, which the summary reports."""
    name = frame.format.name
    fmt = NATIVE.get(name)
    rotated = int(round(float(getattr(frame, "rotation", 0) or 0) / 90)) % 2 == 1
    if fmt is not None and not (rotated and fmt[0] != fmt[1]):
        return frame, fmt, True
    deep = (fmt is not None and fmt[2] > 8) or any(t in name for t in ("10", "12", "16"))
    target = "yuv444p10le" if deep else "yuv444p"
    out = frame.reformat(format=target)
    if rotated:   # reformat drops side data on some versions; Decoded reads the rotation from the frame it is given
        out = _RotatedFrame(out, frame.rotation)
    return out, NATIVE[target], False


class _RotatedFrame:
    """A reformatted frame that keeps the source frame's rotation."""

    def __init__(self, frame, rotation):
        self._frame, self.rotation = frame, rotation

    def __getattr__(self, name):
        return getattr(self._frame, name)


def iter_frames(path, limit=None):
    """Yields (Decoded, pts, time_base, fmt, native, av frame) for every frame, in presentation order."""
    import av
    with av.open(path) as c:
        v = c.streams.video[0]
        v.thread_type = "AUTO"
        n = 0
        for f in c.decode(v):
            if limit is not None and n >= limit:
                return
            f2, fmt, native = _normalise(f)
            yield Decoded(f2, fmt), f.pts, f.time_base or v.time_base, fmt, native, f2
            n += 1


def resample_audio(path, count, duration):
    """Decode the first audio stream for model conditioning, time-scaled so it lines up with 1:1 frames at 24 fps.
    The output keeps the original packets; this copy only conditions the model."""
    import av
    import torch
    with av.open(path) as c:
        if not c.streams.audio:
            return None
        a = c.streams.audio[0]
        sr = a.rate
        res = av.AudioResampler(format="fltp", rate=sr)
        chunks = []
        for f in c.decode(a):
            for g in res.resample(f):
                chunks.append(g.to_ndarray())
        for g in res.resample(None):
            chunks.append(g.to_ndarray())
    if not chunks:
        return None
    wave = torch.from_numpy(np.concatenate(chunks, -1).astype(np.float32))
    wave = wave[..., :round(duration * sr)]
    target = round(count / MODEL_FPS * sr)
    if target != wave.shape[-1] and wave.shape[-1] > 1:
        wave = torch.nn.functional.interpolate(wave[None], size=target, mode="linear", align_corners=False)[0]
    return {"waveform": wave[None], "sample_rate": sr}


def prepare_exact(path, resolution, duration_seconds=0.0):
    """Returns (uint8 frames at the model size, padded to 17n+5), (w, h), source frame count, fps, audio, and whether
    the source's pixel format was native."""
    frames, count, w, h, first, last, native, tb, colour = [], 0, 0, 0, None, None, True, None, None
    for d, pts, tb, fmt, nat, av_frame in iter_frames(path):
        if colour is None:
            if d.w % (1 << fmt[0]) or d.h % (1 << fmt[1]):
                raise ValueError(f"This clip is {d.w}x{d.h}. Exact needs an even width and height for this format; "
                                 "crop it by one pixel and retry.")
            w, h = canvas(d.w, d.h, resolution)
            colour = Colour(av_frame, fmt, d.w, d.h)
            first, native = pts, nat
        if duration_seconds and first is not None and pts is not None and float((pts - first) * tb) >= duration_seconds:
            break
        interp = cv2.INTER_AREA if d.w >= w else cv2.INTER_CUBIC
        rgb = np.clip(cv2.resize(d.rgb(colour), (w, h), interpolation=interp), 0, 1)
        frames.append((rgb * 255 + .5).astype(np.uint8))
        count += 1
        last = pts
    if not count:
        raise ValueError("The video has no decodable frames.")
    span = float((last - first) * tb) if count > 1 and last is not None and first is not None else 0.0
    fps = (count - 1) / span if span > 0 else float(MODEL_FPS)
    frames.extend([frames[-1]] * (h3_length(count) - count))
    return np.stack(frames), (w, h), count, fps, resample_audio(path, count, count / fps), native


def _disk(r):
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def _temporal_max(mask, r):
    out = mask.copy()
    for d in range(1, r + 1):
        out[d:] |= mask[:-d]
        out[:-d] |= mask[d:]
    return out


def edge_offsets(pairs, raw, inner=2, outer=8, sigma=12.0, clamp=24 / 255):
    """Per-frame RGB colour offset of gen vs source, measured just outside the person, smoothed over time. Subtracting
    it removes the VAE's colour drift so the seam doesn't show. Median, so a stray object in the ring can't swing it."""
    T = len(raw)
    out = np.full((T, 3), np.nan, np.float32)
    ki, ko = _disk(inner), _disk(outer)
    for i, (s, g) in enumerate(pairs):
        m = raw[i].astype(np.uint8)
        ring = cv2.dilate(m, ko).astype(bool) & ~cv2.dilate(m, ki).astype(bool)
        if ring.sum() >= 16:
            out[i] = np.median(g[ring] - s[ring], axis=0)
    have = ~np.isnan(out[:, 0])
    if not have.any():
        return np.zeros((T, 3), np.float32)
    x = np.arange(T)
    r = int(sigma * 3)
    kernel = np.exp(-.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    kernel /= kernel.sum()
    for c in range(3):
        filled = np.interp(x, x[have], out[have, c])
        out[:, c] = np.convolve(np.pad(filled, r, mode="edge"), kernel, mode="valid")
    return np.clip(out, -clamp, clamp)


def alpha_at_gen(src_g, gen, subj, allowed, diff_thresh, grow, feather, edge_ramp=0):
    a = cv2.GaussianBlur(src_g, (0, 0), 2.5) * 255
    b = cv2.GaussianBlur(gen, (0, 0), 2.5) * 255
    changed = (np.abs(a - b).mean(-1) > diff_thresh) & allowed
    changed = cv2.morphologyEx(changed.astype(np.uint8), cv2.MORPH_OPEN, _disk(2))
    m = cv2.dilate((changed.astype(bool) | subj).astype(np.uint8), _disk(grow)).astype(bool) & allowed
    alpha = m.astype(np.float32)
    if feather:
        alpha = cv2.GaussianBlur(alpha, (0, 0), feather) * allowed
    if edge_ramp:
        # The model repaints its whole editable area, so the changed area can reach the edge of the mask and leave a
        # visible seam there. Fade to the source over the last edge_ramp px, still inside the mask.
        t = np.clip(cv2.distanceTransform(allowed.astype(np.uint8), cv2.DIST_L2, 5) / edge_ramp, 0, 1)
        alpha = alpha * (t * t * (3 - 2 * t))
    return alpha


def _blend(src, gen, a, top):
    """Exact copy where a == 0."""
    out = src.copy()
    hit = a > 0
    if hit.any():
        v = src[hit].astype(np.float32) * (1 - a[hit]) + gen[hit] * a[hit]
        out[hit] = np.clip(np.rint(v), 0, top).astype(src.dtype)
    return out


def _x264_params(frame):
    parts = []
    for attr, table, key in (("color_primaries", X264_PRIM, "colorprim"), ("color_trc", X264_TRC, "transfer"),
                             ("colorspace", X264_MATRIX, "colormatrix")):
        name = table.get(int(getattr(frame, attr, 2) or 2))
        if name:
            parts.append(f"{key}={name}")
    if int(getattr(frame, "color_range", 0) or 0) == 2 or frame.format.name.startswith("yuvj"):
        parts.append("fullrange=on")
    return ":".join(parts)


def _encode_frame(stream, planes, fmt_name, pts, tb, colour):
    import av
    h, w = planes[0].shape
    out = av.VideoFrame(w, h, fmt_name)
    for i, src in enumerate(planes):
        p = out.planes[i]
        buf = np.zeros((p.height, p.line_size // src.dtype.itemsize), src.dtype)
        buf[:, :src.shape[1]] = src
        p.update(buf.tobytes())
    out.pts, out.time_base = pts, tb
    out.color_range = 2 if colour.full else 1
    if colour.space in X264_MATRIX:
        out.colorspace = colour.space
    return stream.encode(out)


def composite_exact(src_path, gen_at, raw, expanded, out_path, frame_count, crf=14, master=False, diff_thresh=6.0,
                    grow_px=8, feather_px=6, t_radius=2, match_colour=True, on_frame=None, edge_ramp_px=0):
    """gen_at(i) -> (gh, gw, 3) uint8. raw and expanded are (T, gh, gw) bool. frame_count is the source frames the
    model was given: shorter than the source trims the output and its audio to match, longer is an error."""
    import av
    T, gh, gw = raw.shape
    if frame_count > T:
        raise ValueError(f"{frame_count} source frames but only {T} masks.")
    allowed = _temporal_max(expanded[:frame_count], t_radius)
    offsets = np.zeros((frame_count, 3), np.float32)
    colour = None
    if match_colour:
        def pairs():
            nonlocal colour
            for i, (d, _, _, fmt, _, av_f) in enumerate(iter_frames(src_path, frame_count)):
                colour = colour or Colour(av_f, fmt, d.w, d.h)
                s = cv2.resize(d.rgb(colour), (gw, gh), interpolation=cv2.INTER_AREA)
                yield s, gen_at(i).astype(np.float32) / 255
        offsets = edge_offsets(pairs(), raw[:frame_count])

    inp = av.open(src_path)
    out = av.open(out_path, "w", options={"movflags": "+faststart"})
    vin = inp.streams.video[0]
    vin.thread_type = "AUTO"
    ain = inp.streams.audio[0] if inp.streams.audio else None
    vout = aout = resampler = fmt_name = video_end = last_pts = None
    a_copy = False
    n = 0

    def mux(packets):
        for p in packets:
            out.mux(p)

    def write_audio(p):
        if video_end is not None and p.pts is not None and float(p.pts * ain.time_base) >= video_end:
            return
        if a_copy:
            p.stream = aout
            out.mux(p)
            return
        for f in p.decode():
            for g in resampler.resample(f):
                g.pts = None
                mux(aout.encode(g))

    def open_output(d, fmt, frame):
        nonlocal vout, aout, a_copy, resampler, fmt_name, colour
        colour = colour or Colour(frame, fmt, d.w, d.h)
        if d.w % (1 << fmt[0]) or d.h % (1 << fmt[1]):
            raise ValueError(f"Source is {d.w}x{d.h}: x264 needs even dimensions for this chroma format.")
        if abs(d.w / d.h - gw / gh) > .12 * (gw / gh):
            raise ValueError(f"Generated frames {gw}x{gh} don't fit source {d.w}x{d.h}: use CJExactPrepare.")
        fmt_name = frame.format.name.replace("yuvj", "yuv")
        vout = out.add_stream("libx264", rate=vin.average_rate or vin.guessed_rate or fractions.Fraction(MODEL_FPS))
        vout.width, vout.height, vout.pix_fmt = d.w, d.h, fmt_name
        vout.time_base = vin.time_base
        vout.codec_context.time_base = vin.time_base
        opts = {"preset": "slow"}
        opts.update({"qp": "0"} if master else {"crf": str(crf)})
        params = _x264_params(frame)
        if params:
            opts["x264-params"] = params
        vout.options = opts
        if ain is not None:
            if ain.codec_context.name in MP4_AUDIO:
                aout = out.add_stream_from_template(ain)
                a_copy = True
            else:
                aout = out.add_stream("aac", rate=ain.rate)
                resampler = av.AudioResampler(format="fltp", layout="stereo", rate=ain.rate)

    def composite(f):
        nonlocal n, last_pts
        f2, fmt, _ = _normalise(f)
        d = Decoded(f2, fmt)
        if vout is None:
            open_output(d, fmt, f2)
        g = np.clip(gen_at(n).astype(np.float32) / 255 - offsets[n], 0, 1)
        s_g = cv2.resize(d.rgb(colour), (gw, gh), interpolation=cv2.INTER_AREA)
        a_g = alpha_at_gen(s_g, g, raw[n], allowed[n], diff_thresh, grow_px, feather_px, edge_ramp_px)
        planes = d.planes
        a = np.zeros((d.h, d.w), np.float32)
        if a_g.max() > 0:
            a = cv2.resize(a_g, (d.w, d.h), interpolation=cv2.INTER_LINEAR)
            a[a < ALPHA_EPS] = 0
            up = np.clip(cv2.resize(g, (d.w, d.h), interpolation=cv2.INTER_LANCZOS4), 0, 1)
            gy, gu, gv = colour.to_yuv(up)
            ch, cw = planes[1].shape
            a_c = a.copy()
            if (ch, cw) != a.shape:
                a_c = cv2.resize(a, (cw, ch), interpolation=cv2.INTER_AREA)
                a_c[a_c < ALPHA_EPS] = 0
                gu = cv2.resize(gu, (cw, ch), interpolation=cv2.INTER_AREA)
                gv = cv2.resize(gv, (cw, ch), interpolation=cv2.INTER_AREA)
            planes = [_blend(planes[0], gy, a, colour.top), _blend(planes[1], gu, a_c, colour.top),
                      _blend(planes[2], gv, a_c, colour.top)]
        pts = f.pts
        if pts is None or (last_pts is not None and pts <= last_pts):
            step = int(round(1 / (float(vin.average_rate or MODEL_FPS) * float(vin.time_base))))
            pts = (last_pts + step) if last_pts is not None else 0
        mux(_encode_frame(vout, planes, fmt_name, pts, vin.time_base, colour))
        if on_frame:
            on_frame(n, a, planes, pts)
        last_pts = pts
        n += 1

    with av.open(src_path) as scan:
        stamps = sorted(p.pts for p in scan.demux(scan.streams.video[0]) if p.pts is not None)
    if len(stamps) > frame_count:   # trimmed: audio stops where the first dropped frame would start
        video_end = float(stamps[frame_count] * vin.time_base)

    held_audio = []
    try:
        for packet in inp.demux(*([vin, ain] if ain is not None else [vin])):
            if packet.stream.type == "audio":
                if packet.dts is None:
                    continue
                if vout is None:   # the output doesn't exist until the first video frame is decoded
                    held_audio.append(packet)
                else:
                    write_audio(packet)
                continue
            for f in packet.decode():
                if n >= frame_count:
                    continue
                composite(f)
                for p in held_audio:
                    write_audio(p)
                held_audio = []
        if n < frame_count:
            raise ValueError(f"Source yielded {n} frames, expected {frame_count}.")
        mux(vout.encode(None))
        if aout is not None and not a_copy:
            mux(aout.encode(None))
    finally:
        inp.close()
        out.close()
    return {"frames": n, "bit_identical_outside_edit": bool(master), "colour_offset_max": float(np.abs(offsets).max())}


def _local_source(video, tmp):
    src = video.get_stream_source()
    start, duration = video.get_active_trim_window()
    if not isinstance(src, str) or start or duration or getattr(video, "_VideoFromFile__crop", None):
        src = os.path.join(tmp, "source.mkv")
        video.save_to(src)
    return src


class CJExactPrepare:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "video": ("VIDEO",),
            "resolution": (["480", "768"], {"default": "480", "tooltip": "480 = up to 0.5 MP, 768 = up to 1 MP."}),
        }, "optional": {
            "duration_seconds": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 3600.0, "step": 0.1,
                                           "tooltip": "0 = the whole clip. Otherwise the first N seconds."}),
        }}

    RETURN_TYPES = ("IMAGE", "AUDIO", "INT", "INT", "INT", "INT", "FLOAT", "STRING")
    RETURN_NAMES = ("reference_frames", "source_audio", "width", "height", "h3_length", "source_frames", "fps", "summary")
    FUNCTION = "prepare"
    CATEGORY = "image/video"

    def prepare(self, video, resolution, duration_seconds=0.0):
        import torch
        with tempfile.TemporaryDirectory(prefix="cj-exact-") as tmp:
            frames, (w, h), count, fps, audio, native = prepare_exact(_local_source(video, tmp), resolution,
                                                                      duration_seconds)
        summary = (f"{w} x {h}, {count} source frames at {fps:.3f} fps, each sent 1:1.\n"
                   f"H3 length {len(frames)} ({len(frames) - count} repeated tail frames, trimmed on output).")
        if fps > MODEL_FPS + 1:
            summary += f"\nThe model sees this clip {fps / MODEL_FPS:.2f}x slower than real time."
        if not native:
            summary += "\nSource pixel format isn't composited natively: converted to 4:4:4 first."
        return (torch.from_numpy(frames.astype(np.float32) / 255), audio, w, h, len(frames), count, float(fps), summary)


class CJExactPasteSave:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "frames": ("IMAGE", {"tooltip": "Generated frames at the CJExactPrepare size."}),
            "source": ("VIDEO", {"tooltip": "The original LoadVideo."}),
            "raw_mask": ("MASK",),
            "expanded_mask": ("MASK", {"tooltip": "What the model was allowed to change."}),
            "source_frames": ("INT", {"default": 1, "min": 1, "max": MAX_FRAMES}),
            "filename_prefix": ("STRING", {"default": "video/CJ_H3_Exact"}),
        }, "optional": {
            "crf": ("INT", {"default": 14, "min": 0, "max": 51}),
            "master": ("BOOLEAN", {"default": False, "tooltip":
                                   "Lossless x264 (qp 0): pixels outside the edit decode bit-identical. Large files, "
                                   "and browsers won't play them."}),
            "diff_thresh": ("FLOAT", {"default": 6.0, "min": 0.0, "max": 255.0, "step": 0.5}),
            "grow_px": ("INT", {"default": 8, "min": 0, "max": 128}),
            "feather_px": ("INT", {"default": 6, "min": 0, "max": 64}),
            "edge_ramp_px": ("INT", {"default": 0, "min": 0, "max": 128,
                                     "tooltip": "Fade to the source over this many px at the mask edge."}),
            "t_radius": ("INT", {"default": 2, "min": 0, "max": 24}),
            "match_colour": ("BOOLEAN", {"default": True, "tooltip": "Remove the model's colour drift at the mask edge."}),
        }}

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("path", "report")
    OUTPUT_NODE = True
    FUNCTION = "run"
    CATEGORY = "image/video"

    def run(self, frames, source, raw_mask, expanded_mask, source_frames, filename_prefix, crf=14, master=False,
            diff_thresh=6.0, grow_px=8, feather_px=6, t_radius=2, match_colour=True, edge_ramp_px=0):
        import folder_paths
        import torch
        if len(frames) < source_frames:
            raise ValueError(f"Model returned {len(frames)} frames, the source has {source_frames}.")
        raw = raw_mask[:source_frames].cpu().numpy() > .5
        exp = expanded_mask[:source_frames].cpu().numpy() > .5

        def gen_at(i):
            return frames[i, :, :, :3].clamp(0, 1).mul(255).round().to(dtype=torch.uint8).cpu().numpy()

        full, name, counter, sub, _ = folder_paths.get_save_image_path(filename_prefix, folder_paths.get_output_directory())
        os.makedirs(full, exist_ok=True)
        fname = f"{name}_{counter:05}_.mp4"
        out = os.path.join(full, fname)
        with tempfile.TemporaryDirectory(prefix="cj-exact-") as tmp:
            stats = composite_exact(_local_source(source, tmp), gen_at, raw, exp, out, source_frames, crf=crf,
                                    master=master, diff_thresh=diff_thresh, grow_px=grow_px, feather_px=feather_px, edge_ramp_px=edge_ramp_px,
                                    t_radius=t_radius, match_colour=match_colour)
        return {"ui": {"images": [{"filename": fname, "subfolder": sub, "type": "output"}], "animated": (True,)},
                "result": (out, json.dumps(stats))}


def ref_on_scene(ref, scene, ref_mask, scene_mask=None, sigma=24.0, scale=8):
    """Puts the cut-out reference subject on a blurred copy of the scene, with the scene's own subject painted out.
    The model carries the reference's background into its editable area, so a white studio photo glows around the
    person. ref, scene: (h, w, 3) uint8. ref_mask, scene_mask: (h, w) float 0-1, each at its image's size."""
    h, w = ref.shape[:2]
    sh, sw = scene.shape[:2]
    bg = scene
    if scene_mask is not None and (scene_mask > .5).any():
        small = cv2.resize(scene, (max(1, sw // scale), max(1, sh // scale)), interpolation=cv2.INTER_AREA)
        hole = cv2.resize((scene_mask > .5).astype(np.uint8), small.shape[1::-1], interpolation=cv2.INTER_NEAREST)
        hole = cv2.dilate(hole, np.ones((5, 5), np.uint8))
        bg = cv2.inpaint(small, hole, 3, cv2.INPAINT_TELEA)
    # Cover the reference's frame, centred, so its aspect ratio stays.
    k = max(w / bg.shape[1], h / bg.shape[0])
    rw, rh = max(w, round(bg.shape[1] * k)), max(h, round(bg.shape[0] * k))
    bg = cv2.resize(bg, (rw, rh), interpolation=cv2.INTER_LINEAR)
    x, y = (rw - w) // 2, (rh - h) // 2
    bg = cv2.GaussianBlur(bg[y:y + h, x:x + w], (0, 0), sigma)
    # Pull the matte in slightly: a fringe of the old background would still glow.
    a = cv2.erode(np.clip(ref_mask, 0, 1).astype(np.float32), np.ones((5, 5), np.uint8))
    a = cv2.GaussianBlur(a, (0, 0), 1.5)[..., None]
    return (ref * a + bg * (1 - a)).round().astype(np.uint8)


class CJRefOnScene:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"reference": ("IMAGE",), "reference_masks": ("MASK",), "scene": ("IMAGE",)},
                "optional": {"scene_mask": ("MASK",)}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = "cj/h3"
    DESCRIPTION = ("Cuts the subject out of a reference photo and puts it on a blurred copy of the scene, so the photo's "
                   "own background does not glow around the replaced subject. Finding no subject returns the photo as is.")

    def run(self, reference, reference_masks, scene, scene_mask=None):
        import torch
        ref = (reference[0].cpu().numpy() * 255).round().astype(np.uint8)
        h, w = ref.shape[:2]
        rm = reference_masks.cpu().numpy()
        if rm.ndim == 2:
            rm = rm[None]
        areas = (rm > .5).sum(axis=(-1, -2)) if rm.size else np.zeros(0)
        if not len(areas) or areas.max() == 0:
            return (reference,)
        m = cv2.resize(rm[int(areas.argmax())].astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)
        sc = (scene[0].cpu().numpy() * 255).round().astype(np.uint8)
        sm = None
        if scene_mask is not None:
            sm = cv2.resize(scene_mask[0].cpu().numpy().astype(np.float32), sc.shape[1::-1], interpolation=cv2.INTER_NEAREST)
        out = ref_on_scene(ref, sc, m, sm)
        return (torch.from_numpy(out.astype(np.float32) / 255)[None].to(reference.device),)


NODE_CLASS_MAPPINGS = {"CJExactPrepare": CJExactPrepare, "CJExactPasteSave": CJExactPasteSave,
                       "CJRefOnScene": CJRefOnScene}
NODE_DISPLAY_NAME_MAPPINGS = {"CJExactPrepare": "Exact Prepare (every source frame, no crop)",
                              "CJExactPasteSave": "Exact Paste Back + Save (source timing, native YUV)",
                              "CJRefOnScene": "Reference On Scene (hide the photo's background)"}

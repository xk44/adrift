"""follow-cam crop + paste-back, so a small subject in a wide shot is rendered at full model resolution.

A person filling 1/8 of a 480p frame gets ~60 px of height; H3 renders faces and hands at that size badly.
Follow-cam tracks the subject mask, crops a smoothed window around it from a hi-res plate, runs the tool on
the crop at the model's resolution, and pastes the result back into the plate with a feathered mask limited
to the subject region. The plate stays in the generation geometry (H3 prepare's cover crop) at source
detail, so CJPasteBackSave composites it onto the source like a 2K finish.

CJFollowCamPlate     source video -> frames in the prepared clip's geometry at (up to) source resolution
CJFollowCamTrack     subject mask -> per-frame crop windows (FOLLOWCAM): offline gaussian smoothing of the
                      centre, a running-max envelope of the size (the subject never leaves the window),
                      padding, clamped to the frame, fixed aspect = the model's output size. mode "auto"
                      falls back to the full frame when the subject is already large.
CJFollowCamCrop      any frames (plate, shading, ...) -> crops at the model size
CJFollowCamCropMask  any mask -> crops at the model size
CJFollowCamPaste     crops -> pasted into base frames; alpha = feathered, grown crop-space mask, faded to 0
                      at the crop border, so no box seam shows. Pixels outside the window are untouched.

Windows are normalized [x0, y0, w, h] in [0, 1], so masks, plate and crops may have any resolution.
Idea (follow-cam crop + paste-back into the untouched plate) from Body Double (lucataco, Apache-2.0);
no code from it is used.
"""
import math
import os
import subprocess
import tempfile

import torch
import torch.nn.functional as F


# ---------------------------------------------------------------- track math

def mask_boxes(mask, thresh=0.5):
    """mask (T, H, W) -> boxes (T, 4) normalized [x0, y0, x1, y1] (pixel edges), valid (T,) bool."""
    m = mask > thresh
    T, H, W = m.shape
    rows, cols = m.any(2), m.any(1)
    valid = rows.any(1)
    ys = torch.arange(H, dtype=torch.float32)
    xs = torch.arange(W, dtype=torch.float32)
    big = torch.tensor(1e9)
    y0 = torch.where(rows, ys, big).amin(1)
    y1 = torch.where(rows, ys + 1, -big).amax(1)
    x0 = torch.where(cols, xs, big).amin(1)
    x1 = torch.where(cols, xs + 1, -big).amax(1)
    boxes = torch.stack([x0 / W, y0 / H, x1 / W, y1 / H], 1)
    boxes[~valid] = 0
    return boxes, valid


def fill_missing(values, valid):
    """(T, K) values; frames without a subject are linearly interpolated, held at the ends."""
    T = values.shape[0]
    idx = torch.nonzero(valid).flatten()
    if len(idx) == 0:
        return values.clone()
    out = values.clone()
    t = torch.arange(T, dtype=torch.float32)
    for k in range(values.shape[1]):
        v = values[idx, k]
        p = idx.float()
        j = torch.searchsorted(p, t).clamp(1, max(1, len(p) - 1))
        if len(p) == 1:
            out[:, k] = v[0]
            continue
        lo, hi = p[j - 1], p[j]
        w = ((t - lo) / (hi - lo)).clamp(0, 1)
        out[:, k] = v[j - 1] * (1 - w) + v[j] * w
    return out


def gaussian_1d(x, sigma):
    """Zero-phase gaussian smoothing of (T,), edge-replicated (whole clip is known: no lag)."""
    if sigma <= 0 or x.numel() < 2:
        return x.clone()
    r = max(1, int(math.ceil(3 * sigma)))
    k = torch.arange(-r, r + 1, dtype=torch.float32)
    k = torch.exp(-(k * k) / (2 * sigma * sigma))
    k = k / k.sum()
    y = F.pad(x.view(1, 1, -1).float(), (r, r), mode="replicate")
    return F.conv1d(y, k.view(1, 1, -1)).view(-1)


def running_max(x, r):
    if r <= 0:
        return x.clone()
    y = F.pad(x.view(1, 1, -1).float(), (r, r), mode="replicate")
    return F.max_pool1d(y, 2 * r + 1, stride=1).view(-1)


def track_windows(mask, out_w, out_h, padding=0.15, smooth=6.0, max_zoom=4.0, mode="auto", auto_min_zoom=1.5,
                  thresh=0.5):
    """mask (T, H, W) -> windows (T, 4) normalized [x0, y0, w, h], median zoom, active.

    Window aspect in pixels = out_w / out_h. Size s = normalized window height; zoom = s_max / s where s_max is the
    largest window that fits the frame. Inactive (auto and subject already large, or no subject): full window."""
    T, H, W = mask.shape
    A = W / H
    R = out_w / out_h
    wr = R / A                                       # normalized width per normalized height
    s_max = min(1.0, 1.0 / wr)
    boxes, valid = mask_boxes(mask, thresh)

    def full():
        s = torch.full((T,), s_max)
        cx = torch.full((T,), 0.5)
        cy = torch.full((T,), 0.5)
        return s, cx, cy

    active = bool(valid.any()) and mode != "off"
    if active:
        b = fill_missing(boxes, valid)
        bw, bh = (b[:, 2] - b[:, 0]), (b[:, 3] - b[:, 1])
        cx, cy = (b[:, 0] + b[:, 2]) / 2, (b[:, 1] + b[:, 3]) / 2
        pad = 1 + 2 * max(0.0, padding)
        s_req = torch.maximum(bh * pad, bw * pad / wr)
        s_min = s_max / max(1.0, max_zoom)
        s_req = s_req.clamp(s_min, s_max)
        s = gaussian_1d(running_max(s_req, int(math.ceil(2 * smooth))), 2 * smooth)
        s = torch.maximum(s, s_req).clamp(s_min, s_max)
        cx, cy = gaussian_1d(cx, smooth), gaussian_1d(cy, smooth)
        zoom = float(s_max / s.median())
        if mode == "auto" and zoom < auto_min_zoom:
            active = False
    if not active:
        s, cx, cy = full()
        zoom = 1.0
    w = s * wr
    x0 = (cx - w / 2).clamp(min=0)
    x0 = torch.minimum(x0, 1 - w)
    y0 = (cy - s / 2).clamp(min=0)
    y0 = torch.minimum(y0, 1 - s)
    return torch.stack([x0, y0, w, s], 1), zoom, active


# ---------------------------------------------------------------- sampling

def _grid(win, out_w, out_h):
    """Sampling grid (1, out_h, out_w, 2) for one window over a whole frame (align_corners=False coordinates)."""
    x0, y0, w, h = [float(v) for v in win]
    u = x0 + (torch.arange(out_w, dtype=torch.float32) + 0.5) / out_w * w
    v = y0 + (torch.arange(out_h, dtype=torch.float32) + 0.5) / out_h * h
    gy, gx = torch.meshgrid(v * 2 - 1, u * 2 - 1, indexing="ij")
    return torch.stack([gx, gy], -1).unsqueeze(0)


def _prefilter(x, factor):
    """Antialias before a >1.5x shrink: grid_sample alone aliases. Normalized coordinates are size independent."""
    if factor <= 1.5:
        return x
    h, w = x.shape[-2:]
    return F.interpolate(x, size=(max(1, round(h / factor)), max(1, round(w / factor))), mode="bilinear",
                         antialias=True, align_corners=False)


def crop_frames(images, windows, out_w, out_h):
    """images (T, H, W, C) -> (T, out_h, out_w, C)."""
    T = min(len(images), len(windows))
    H, W = images.shape[1:3]
    out = torch.empty((T, out_h, out_w, images.shape[3]), dtype=torch.float32)
    for t in range(T):
        win = windows[t]
        f = min(float(win[2]) * W / out_w, float(win[3]) * H / out_h)
        src = _prefilter(images[t:t + 1].float().permute(0, 3, 1, 2), f)
        o = F.grid_sample(src, _grid(win, out_w, out_h).to(src.device), mode="bilinear", padding_mode="border",
                          align_corners=False)
        out[t] = o[0].permute(1, 2, 0).cpu()
    return out


def crop_masks(mask, windows, out_w, out_h):
    """mask (T, H, W) -> (T, out_h, out_w)."""
    return crop_frames(mask.unsqueeze(-1), windows, out_w, out_h)[..., 0]


def _blur2d(x, sigma):
    if sigma <= 0:
        return x
    r = max(1, int(math.ceil(3 * sigma)))
    k = torch.arange(-r, r + 1, dtype=torch.float32)
    k = torch.exp(-(k * k) / (2 * sigma * sigma))
    k = k / k.sum()
    x = F.conv2d(F.pad(x, (r, r, 0, 0), mode="replicate"), k.view(1, 1, 1, -1))
    return F.conv2d(F.pad(x, (0, 0, r, r), mode="replicate"), k.view(1, 1, -1, 1))


def crop_alpha(mask, h, w, grow_px=4, feather_px=6, edge_px=8):
    """Crop-space alpha (T, h, w): grow + feather the subject mask, fade to 0 over edge_px at the crop border.
    mask None = the whole crop (still edge-faded)."""
    if mask is None:
        a = torch.ones((1, 1, h, w))
        T = 1
    else:
        T = mask.shape[0]
        a = F.interpolate(mask.float().unsqueeze(1), size=(h, w), mode="bilinear", align_corners=False)
        a = (a > 0.5).float()
        if grow_px > 0:
            a = F.max_pool2d(a, 2 * grow_px + 1, stride=1, padding=grow_px)
        a = _blur2d(a, feather_px)
    if edge_px > 0:
        ry = ((torch.arange(h, dtype=torch.float32) + 0.5) / edge_px).clamp(max=1)
        rx = ((torch.arange(w, dtype=torch.float32) + 0.5) / edge_px).clamp(max=1)
        ramp = torch.minimum(torch.minimum(ry, ry.flip(0))[:, None], torch.minimum(rx, rx.flip(0))[None, :])
        a = a * ramp
    return a[:, 0].clamp(0, 1).expand(T, h, w) if mask is None else a[:, 0].clamp(0, 1)


def paste_frames(base, crops, windows, alpha=None):
    """Paste crops (T, h, w, C) into base (T, H, W, C) through their windows; alpha (T, h, w) crop-space.
    Returns (frames, plate-space alpha (T, H, W)). Only the window's pixel rectangle is resampled."""
    T = min(len(base), len(crops), len(windows))
    H, W = base.shape[1:3]
    h, w = crops.shape[1:3]
    out = base[:T].float().clone()
    full_a = torch.zeros((T, H, W), dtype=torch.float32)
    for t in range(T):
        x0, y0, ww, wh = [float(v) for v in windows[t]]
        px0, px1 = max(0, math.floor(x0 * W)), min(W, math.ceil((x0 + ww) * W))
        py0, py1 = max(0, math.floor(y0 * H)), min(H, math.ceil((y0 + wh) * H))
        if px1 <= px0 or py1 <= py0:
            continue
        u = ((torch.arange(px0, px1, dtype=torch.float32) + 0.5) / W - x0) / ww
        v = ((torch.arange(py0, py1, dtype=torch.float32) + 0.5) / H - y0) / wh
        gy, gx = torch.meshgrid(v * 2 - 1, u * 2 - 1, indexing="ij")
        grid = torch.stack([gx, gy], -1).unsqueeze(0)
        f = min(w / max(1e-6, ww * W), h / max(1e-6, wh * H))
        a_t = alpha[min(t, len(alpha) - 1)] if alpha is not None else torch.ones((h, w))
        rgb = F.grid_sample(_prefilter(crops[t:t + 1].float().permute(0, 3, 1, 2), f), grid, mode="bilinear",
                            padding_mode="border", align_corners=False)[0].permute(1, 2, 0)
        a = F.grid_sample(_prefilter(a_t.view(1, 1, h, w).float(), f), grid, mode="bilinear", padding_mode="zeros",
                          align_corners=False)[0, 0].clamp(0, 1)
        region = out[t, py0:py1, px0:px1]
        out[t, py0:py1, px0:px1] = region * (1 - a[..., None]) + rgb.clamp(0, 1) * a[..., None]
        full_a[t, py0:py1, px0:px1] = a
    return out, full_a


# ---------------------------------------------------------------- plate

def plate_size(src_w, src_h, gen_w, gen_h, max_side=1920):
    """Plate = the prepared clip's geometry at source detail: gen size * (source px per gen px), never below gen,
    long side capped at max_side. Even sizes (yuv-friendly)."""
    dar = src_w / src_h
    sw = max(gen_w, gen_h * dar)
    k = max(1.0, src_w / sw)
    k = min(k, max(1.0, max_side / max(gen_w, gen_h)))
    return int(round(gen_w * k / 2)) * 2, int(round(gen_h * k / 2)) * 2


def _source_path(source, tmp):
    src = source.get_stream_source()
    start, duration = source.get_active_trim_window()
    if not isinstance(src, str) or start or duration or getattr(source, "_VideoFromFile__crop", None):
        src = os.path.join(tmp, "source.mkv")
        source.save_to(src)
    return src


def decode_plate(path, gen_w, gen_h, count, max_side=1920):
    """Same 24 fps resample + cover crop as LabsH3PrepareVideo, at plate size. Pads with the last frame."""
    from .cj_pasteback import RGB_DECODE_VF, cover_crop_geometry, probe_wh
    src_w, src_h = probe_wh(path)
    pw, ph = plate_size(src_w, src_h, gen_w, gen_h, max_side)
    _, x0, y0, (sw, sh) = cover_crop_geometry(src_w, src_h, pw, ph)
    vf = (f"setpts=PTS-STARTPTS,fps=fps=24:round=near:eof_action=round,scale={sw}:{sh}:flags=lanczos,"
          f"crop={pw}:{ph}:{x0}:{y0},{RGB_DECODE_VF}")
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-map", "0:v:0", "-vf", vf,
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    out = torch.empty((count, ph, pw, 3), dtype=torch.float32)
    n, size = 0, pw * ph * 3
    try:
        while n < count:
            b = p.stdout.read(size)
            if len(b) < size:
                break
            out[n] = torch.frombuffer(bytearray(b), dtype=torch.uint8).view(ph, pw, 3).float() / 255
            n += 1
    finally:
        p.kill()
        p.wait()
    if n == 0:
        raise RuntimeError(f"follow-cam plate: no frames decoded from {path}")
    if n < count:
        out[n:] = out[n - 1]
    return out


# ---------------------------------------------------------------- nodes

class CJFollowCamPlate:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "source": ("VIDEO", {"tooltip": "The ORIGINAL LoadVideo."}),
            "frames": ("IMAGE", {"tooltip": "The prepared frames (LabsH3PrepareVideo): geometry + frame count."}),
        }, "optional": {
            "max_side": ("INT", {"default": 1920, "min": 256, "max": 4096, "step": 32,
                                 "tooltip": "Long-side cap of the plate (RAM: T x W x H x 12 bytes)."}),
        }}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("plate",)
    FUNCTION = "run"
    CATEGORY = "image/video"

    def run(self, source, frames, max_side=1920):
        gh, gw = int(frames.shape[1]), int(frames.shape[2])
        with tempfile.TemporaryDirectory(prefix="cj-followcam-") as tmp:
            return (decode_plate(_source_path(source, tmp), gw, gh, len(frames), max_side),)


class CJFollowCamTrack:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "mask": ("MASK", {"tooltip": "Per-frame subject mask (include everything the tool may change)."}),
            "width": ("INT", {"default": 832, "min": 32, "max": 8192, "tooltip": "Model width (crop output)."}),
            "height": ("INT", {"default": 480, "min": 32, "max": 8192, "tooltip": "Model height (crop output)."}),
        }, "optional": {
            "mode": (["auto", "on", "off"], {"default": "auto", "tooltip":
                     "auto: follow only when the subject is small (zoom >= auto_min_zoom); off: full frame."}),
            "padding": ("FLOAT", {"default": 0.15, "min": 0.0, "max": 2.0, "step": 0.01,
                                  "tooltip": "Margin around the subject box, per side, as a fraction of its size."}),
            "smooth": ("FLOAT", {"default": 6.0, "min": 0.0, "max": 48.0, "step": 0.5,
                                 "tooltip": "Gaussian sigma in frames for the window centre (size uses 2x)."}),
            "max_zoom": ("FLOAT", {"default": 4.0, "min": 1.0, "max": 8.0, "step": 0.1}),
            "auto_min_zoom": ("FLOAT", {"default": 1.5, "min": 1.0, "max": 8.0, "step": 0.05}),
        }}

    RETURN_TYPES = ("FOLLOWCAM", "FLOAT", "STRING")
    RETURN_NAMES = ("followcam", "zoom", "info")
    FUNCTION = "run"
    CATEGORY = "image/video"

    def run(self, mask, width, height, mode="auto", padding=0.15, smooth=6.0, max_zoom=4.0, auto_min_zoom=1.5):
        m = mask if mask.dim() == 3 else mask.view(-1, *mask.shape[-2:])
        win, zoom, active = track_windows(m.float().cpu(), width, height, padding, smooth, max_zoom, mode,
                                          auto_min_zoom)
        info = f"follow-cam {'on' if active else 'off'} ({mode}), median zoom {zoom:.2f}x, {len(win)} frames"
        return ({"windows": win, "width": int(width), "height": int(height), "active": active, "zoom": zoom},
                zoom, info)


class CJFollowCamCrop:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "followcam": ("FOLLOWCAM",)}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = "image/video"

    def run(self, images, followcam):
        fc = followcam
        return (crop_frames(images, _windows_for(fc, len(images)), fc["width"], fc["height"]),)


class CJFollowCamCropMask:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"mask": ("MASK",), "followcam": ("FOLLOWCAM",)}}

    RETURN_TYPES = ("MASK",)
    FUNCTION = "run"
    CATEGORY = "image/video"

    def run(self, mask, followcam):
        fc = followcam
        m = mask if mask.dim() == 3 else mask.view(-1, *mask.shape[-2:])
        return (crop_masks(m.float().cpu(), _windows_for(fc, len(m)), fc["width"], fc["height"]),)


class CJFollowCamPaste:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "base": ("IMAGE", {"tooltip": "Frames to paste into (the plate, or the previous subject's paste)."}),
            "crops": ("IMAGE", {"tooltip": "The tool's output on the crops (any resolution, same aspect)."}),
            "followcam": ("FOLLOWCAM",),
        }, "optional": {
            "mask": ("MASK", {"tooltip": "Crop-space subject / edit mask. Empty: the whole crop."}),
            "grow_px": ("INT", {"default": 4, "min": 0, "max": 128}),
            "feather_px": ("INT", {"default": 6, "min": 0, "max": 64}),
            "edge_px": ("INT", {"default": 8, "min": 0, "max": 128,
                                "tooltip": "Fade to the base over this many crop pixels at the window border."}),
        }}

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("frames", "alpha")
    FUNCTION = "run"
    CATEGORY = "image/video"

    def run(self, base, crops, followcam, mask=None, grow_px=4, feather_px=6, edge_px=8):
        T = min(len(base), len(crops))
        win = _windows_for(followcam, T)
        h, w = int(crops.shape[1]), int(crops.shape[2])
        m = None if mask is None else (mask if mask.dim() == 3 else mask.view(-1, *mask.shape[-2:]))
        alpha = crop_alpha(None if m is None else m[:T].float().cpu(), h, w, grow_px, feather_px, edge_px)
        return paste_frames(base[:T].cpu(), crops[:T].cpu(), win, alpha)


def _windows_for(fc, n):
    win = fc["windows"]
    if len(win) >= n:
        return win[:n]
    return torch.cat([win, win[-1:].expand(n - len(win), 4)], 0)


NODE_CLASS_MAPPINGS = {
    "CJFollowCamPlate": CJFollowCamPlate,
    "CJFollowCamTrack": CJFollowCamTrack,
    "CJFollowCamCrop": CJFollowCamCrop,
    "CJFollowCamCropMask": CJFollowCamCropMask,
    "CJFollowCamPaste": CJFollowCamPaste,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "CJFollowCamPlate": "Follow-Cam Plate (source detail, prepared geometry)",
    "CJFollowCamTrack": "Follow-Cam Track (smoothed subject window)",
    "CJFollowCamCrop": "Follow-Cam Crop Frames",
    "CJFollowCamCropMask": "Follow-Cam Crop Mask",
    "CJFollowCamPaste": "Follow-Cam Paste Back (feathered, subject only)",
}

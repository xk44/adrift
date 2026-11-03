"""Depth-aware lens blur: CJRefocus (one focus point) and CJRackFocus (focus pulls from point A to point B).

Depth input is an IMAGE depth map with near = white (core DA3Render "depth", Depth Anything / MiDaS
convention). Circle of confusion per pixel: radius = max(0, |depth - focal| - focus_range) * aperture_px,
signed (+ = in front of the focal plane, - = behind).

Layered gather, not "blur the masked image": pixels are split into CoC layers, each layer is blurred as
premultiplied colour + coverage with its own disc and composited far -> near.
- Background group (behind + in focus): over-composited, then divided by its coverage, so a blurred
  background next to a sharp subject only averages background pixels (no subject halo).
- Foreground group (in front): composited over the background group, whose holes behind foreground objects
  are filled by normalized convolution. Where a blurred foreground disc only partly covers a pixel, the
  uncovered part shows that filled background (soft see-through edge); where the deficit only comes from
  layer seams on one continuous surface it is renormalized instead (no seam lines).
Optional highlight boost works in linear light so bright points bloom into discs.
Torch only.
"""
import logging
import math

import torch
import torch.nn.functional as F

_log = logging.getLogger("cj_image_tools")

KERNEL_MAX_RADIUS = 8      # px at the working scale; bigger CoCs blur a downscaled layer
EPS = 1e-6


def srgb_to_linear(x):
    return torch.where(x <= 0.04045, x / 12.92, ((x.clamp(min=0) + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(x):
    x = x.clamp(0.0, 1.0)
    return torch.where(x <= 0.0031308, x * 12.92, 1.055 * x.clamp(min=1e-12) ** (1 / 2.4) - 0.055)


def coc_map(depth, focal, aperture_px, focus_range=0.0, max_radius=None):
    """Signed circle-of-confusion radius in pixels (+ = nearer than the focal plane)."""
    diff = depth - focal
    mag = (diff.abs() - focus_range).clamp(min=0.0) * aperture_px
    if max_radius is not None:
        mag = mag.clamp(max=max_radius)
    return torch.sign(diff) * mag


def disc_kernel(radius, device=None, dtype=torch.float32):
    """Antialiased flat disc, sum 1. radius < 0.5 -> identity (1x1)."""
    if radius < 0.5:
        return torch.ones(1, 1, device=device, dtype=dtype)
    n = int(math.ceil(radius))
    ax = torch.arange(-n, n + 1, device=device, dtype=dtype)
    dist = torch.sqrt(ax[None, :] ** 2 + ax[:, None] ** 2)
    k = (radius + 0.5 - dist).clamp(0.0, 1.0)
    return k / k.sum()


def disc_blur(x, radius):
    """Disc blur of (1, C, H, W). Large radii run on an area-downscaled copy (blur hides the resample)."""
    if radius < 0.5:
        return x
    _, c, h, w = x.shape
    scale = max(1.0, radius / KERNEL_MAX_RADIUS)
    if scale > 1.0:
        sh, sw = max(1, round(h / scale)), max(1, round(w / scale))
        xs = F.interpolate(x, size=(sh, sw), mode="area")
        r = radius * (sh / h + sw / w) / 2
    else:
        xs, r = x, radius
    k = disc_kernel(r, x.device, x.dtype)
    p = k.shape[-1] // 2
    if p > 0:
        pad_mode = "replicate" if p < min(xs.shape[-2:]) else "constant"
        xs = F.pad(xs, (p, p, p, p), mode=pad_mode)
        xs = F.conv2d(xs, k.expand(c, 1, -1, -1).contiguous(), groups=c)
    if scale > 1.0:
        xs = F.interpolate(xs, size=(h, w), mode="bilinear", align_corners=False)
    return xs


def fill_holes(color, weight, start_radius):
    """Normalized convolution: color where weight is solid, else the weighted average of ever wider rings."""
    _, _, h, w = color.shape
    filled = color.clone()
    need = weight < 0.999
    if not bool(need.any()):
        return filled
    have = torch.zeros_like(weight, dtype=torch.bool)
    est = torch.zeros_like(color)
    r = max(2.0, float(start_radius))
    limit = 2.0 * max(h, w)
    while True:
        num = disc_blur(torch.cat([color * weight, weight], 1), r)
        den = num[:, -1:]
        ok = (den > 1e-3) & ~have
        est = torch.where(ok, num[:, :-1] / den.clamp(min=EPS), est)
        have = have | ok
        if bool(have.all()) or r >= limit:
            break
        r *= 2.0
    if not bool(have.all()):
        tot = weight.sum()
        mean = (color * weight).sum(dim=(2, 3), keepdim=True) / tot.clamp(min=EPS)
        est = torch.where(have, est, mean.expand_as(est))
    # weak (spill) coverage is kept as is; only near-empty pixels take the estimate
    t = ((weight - 0.01) / 0.04).clamp(0.0, 1.0)
    return color * t + est * (1 - t)


def lens_blur(image, coc, highlights=0.0, highlight_threshold=0.85, linear=True, layers_per_side=12):
    """image (C,H,W) sRGB in [0,1]; coc (H,W) signed px. Returns (C,H,W)."""
    rmax = float(coc.abs().max())
    if rmax < 0.5:
        return image.clone()
    x = image.unsqueeze(0)
    if linear:
        x = srgb_to_linear(x)
    if highlights > 0:
        luma = (0.2126 * image[0] + 0.7152 * image[1] + 0.0722 * image[2]) if image.shape[0] >= 3 else image[0]
        hl = ((luma - highlight_threshold) / max(1e-3, 1 - highlight_threshold)).clamp(0, 1) ** 2
        blurred_enough = (coc.abs() / 3.0).clamp(0, 1)
        x = x * (1 + highlights * 8.0 * hl * blurred_enough)[None, None]

    step = max(0.75, rmax / max(1, layers_per_side))
    idx = torch.round(coc / step).to(torch.int64)
    levels = sorted(int(v) for v in torch.unique(idx))

    def composite(level_list):
        out = torch.zeros_like(x)
        acc = torch.zeros_like(x[:, :1])
        cov = torch.zeros_like(x[:, :1])
        for k in level_list:
            m = (idx == k).to(x.dtype)[None, None]
            r = float(coc[idx == k].abs().mean())
            b = disc_blur(torch.cat([x * m, m], 1), r)
            cb, ab = b[:, :-1], b[:, -1:].clamp(0, 1)
            out = cb + (1 - ab) * out
            acc = ab + (1 - ab) * acc
            cov = cov + ab
        return out, acc, cov

    bg_levels = [k for k in levels if k <= 0]
    fg_levels = [k for k in levels if k > 0]
    bg, bg_acc, _ = composite(bg_levels)
    bg_norm = bg / bg_acc.clamp(min=EPS)
    bg_full = fill_holes(bg_norm, bg_acc, start_radius=rmax)
    if fg_levels:
        fg, fg_acc, fg_cov = composite(fg_levels)
        deficit = 1 - fg_acc
        see = (1 - fg_cov).clamp(0, 1).minimum(deficit)
        out = fg + see * bg_full + (deficit - see) * fg / fg_acc.clamp(min=EPS)
    else:
        out = bg_full
    out = out[0]
    if linear:
        out = linear_to_srgb(out)
    return out.clamp(0, 1)


def depth_frames(depth, h, w, invert=False):
    """(B,H,W,C) depth IMAGE -> (B,h,w) in [0,1], near = 1."""
    d = depth[..., :3].float().mean(dim=-1) if depth.dim() == 4 else depth.float()
    if d.shape[-2:] != (h, w):
        d = F.interpolate(d[:, None], size=(h, w), mode="bilinear", align_corners=False)[:, 0]
    d = d.clamp(0, 1)
    return 1 - d if invert else d


def smooth_depth(d, strength):
    """Zero-phase EMA over frames (B,H,W); strength in [0,1)."""
    a = float(min(max(strength, 0.0), 0.95))
    if a <= 0 or d.shape[0] < 2:
        return d
    fwd = d.clone()
    for i in range(1, d.shape[0]):
        fwd[i] = a * fwd[i - 1] + (1 - a) * d[i]
    out = fwd.clone()
    for i in range(d.shape[0] - 2, -1, -1):
        out[i] = a * out[i + 1] + (1 - a) * fwd[i]
    return out


def sample_depth(d, x, y, radius_frac=0.012):
    """Median depth in a small window around normalized (x, y) of one (H,W) map."""
    h, w = d.shape
    cx = min(w - 1, max(0, int(round(x * (w - 1)))))
    cy = min(h - 1, max(0, int(round(y * (h - 1)))))
    r = max(1, int(round(radius_frac * min(h, w))))
    win = d[max(0, cy - r):cy + r + 1, max(0, cx - r):cx + r + 1]
    return float(win.median())


def smooth_track(values, window=5):
    """Running median of a scalar per-frame track (keeps steps, drops single-frame spikes)."""
    if len(values) < 3:
        return list(values)
    half = window // 2
    out = []
    for i in range(len(values)):
        seg = sorted(values[max(0, i - half):i + half + 1])
        out.append(seg[len(seg) // 2])
    return out


EASES = ("smooth", "linear", "ease_in", "ease_out")


def ease(s, kind="smooth"):
    s = min(1.0, max(0.0, s))
    if kind == "linear":
        return s
    if kind == "ease_in":
        return s * s * s
    if kind == "ease_out":
        return 1 - (1 - s) ** 3
    return s * s * (3 - 2 * s)


def rack_progress(t, t_a, t_b, kind="smooth"):
    """0 at/before t_a, 1 at/after t_b, eased in between (t_b <= t_a -> a cut at t_a)."""
    if t_b <= t_a:
        return 0.0 if t < t_a else 1.0
    return ease((t - t_a) / (t_b - t_a), kind)


def aperture_px(blur_amount, h, w):
    """blur_amount = CoC radius in % of the long side at a full near-to-far depth difference."""
    return max(0.0, float(blur_amount)) / 100.0 * max(h, w)


def _device():
    try:
        import comfy.model_management as mm
        return mm.get_torch_device()
    except Exception:
        return torch.device("cpu")


def _progress(n):
    try:
        import comfy.utils
        return comfy.utils.ProgressBar(n)
    except Exception:
        return None


def render(images, depth, focal_for_frame, blur_amount, focus_range, highlights, depth_smoothing, invert_depth):
    """Shared per-frame loop. focal_for_frame(i, depth_maps) -> focal depth of frame i."""
    b, h, w, c = images.shape
    d = depth_frames(depth, h, w, invert_depth)
    if d.shape[0] == 1 and b > 1:
        d = d.expand(b, -1, -1)
    elif d.shape[0] != b:
        raise ValueError(f"depth has {d.shape[0]} frames, image has {b}")
    d = smooth_depth(d, depth_smoothing)
    ap = aperture_px(blur_amount, h, w)
    dev = _device()
    pbar = _progress(b)
    out = torch.empty_like(images)
    with torch.no_grad():
        for i in range(b):
            focal = focal_for_frame(i, d)
            coc = coc_map(d[i].to(dev), focal, ap, focus_range)
            img = images[i, ..., :3].permute(2, 0, 1).to(dev).float()
            res = lens_blur(img, coc, highlights=highlights)
            out[i, ..., :3] = res.permute(1, 2, 0).to(out.device, out.dtype)
            if c > 3:
                out[i, ..., 3:] = images[i, ..., 3:]
            if pbar:
                pbar.update(1)
    return out


_COMMON = {
    "blur_amount": ("FLOAT", {"default": 2.5, "min": 0.0, "max": 10.0, "step": 0.05,
                    "tooltip": "Aperture: blur radius in % of the long side between the nearest and farthest depth"}),
    "focus_range": ("FLOAT", {"default": 0.03, "min": 0.0, "max": 0.5, "step": 0.005,
                    "tooltip": "Depth band around the focal plane that stays fully sharp (0..1 depth units)"}),
    "highlights": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 1.0, "step": 0.05,
                   "tooltip": "Bokeh highlight boost: bright out-of-focus points bloom into discs"}),
    "depth_smoothing": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 0.95, "step": 0.05,
                        "tooltip": "Video: temporal smoothing of the depth maps (reduces focus flicker)"}),
    "invert_depth": ("BOOLEAN", {"default": False, "tooltip": "Set when the depth map is far = white"}),
}


class CJRefocus:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "depth": ("IMAGE", {"tooltip": "Depth map, near = white (DA3Render depth)"}),
                "focus_x": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.001}),
                "focus_y": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.001}),
                **_COMMON,
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"
    CATEGORY = "image/postprocessing"

    def run(self, image, depth, focus_x=0.5, focus_y=0.5, blur_amount=2.5, focus_range=0.03, highlights=0.3,
            depth_smoothing=0.25, invert_depth=False):
        track = []

        def focal(i, d):
            if not track:
                track.extend(smooth_track([sample_depth(d[k], focus_x, focus_y) for k in range(d.shape[0])]))
            return track[i]

        return (render(image, depth, focal, blur_amount, focus_range, highlights, depth_smoothing, invert_depth),)


class CJRackFocus:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "depth": ("IMAGE", {"tooltip": "Per-frame depth maps, near = white (DA3Render depth)"}),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 240.0, "step": 0.001}),
                "a_x": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.001}),
                "a_y": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.001}),
                "a_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.01,
                           "tooltip": "Seconds: focus holds on A until here"}),
                "b_x": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.001}),
                "b_y": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.001}),
                "b_time": ("FLOAT", {"default": 2.0, "min": 0.0, "max": 100000.0, "step": 0.01,
                           "tooltip": "Seconds: focus has landed on B here"}),
                "ease": (list(EASES), {"default": "smooth"}),
                **_COMMON,
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "run"
    CATEGORY = "image/postprocessing"

    def run(self, images, depth, fps=24.0, a_x=0.5, a_y=0.5, a_time=0.0, b_x=0.5, b_y=0.5, b_time=2.0,
            ease="smooth", blur_amount=2.5, focus_range=0.03, highlights=0.3, depth_smoothing=0.25,
            invert_depth=False):
        if b_time < a_time:
            a_x, a_y, a_time, b_x, b_y, b_time = b_x, b_y, b_time, a_x, a_y, a_time
        plan = []

        def focal(i, d):
            if not plan:
                # each point is re-sampled on every frame so subject motion and depth normalisation drift follow
                fa = smooth_track([sample_depth(d[k], a_x, a_y) for k in range(d.shape[0])])
                fb = smooth_track([sample_depth(d[k], b_x, b_y) for k in range(d.shape[0])])
                for k in range(d.shape[0]):
                    s = rack_progress(k / max(fps, 1e-3), a_time, b_time, ease)
                    plan.append(fa[k] + (fb[k] - fa[k]) * s)
            return plan[i]

        _log.info("CJRackFocus: %d frames, A@%.2fs -> B@%.2fs (%s)", images.shape[0], a_time, b_time, ease)
        return (render(images, depth, focal, blur_amount, focus_range, highlights, depth_smoothing, invert_depth),)


NODE_CLASS_MAPPINGS = {"CJRefocus": CJRefocus, "CJRackFocus": CJRackFocus}
NODE_DISPLAY_NAME_MAPPINGS = {
    "CJRefocus": "Refocus (depth lens blur)",
    "CJRackFocus": "Rack Focus (depth lens blur)",
}

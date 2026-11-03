"""per-frame video masks -> stable masks, and matte compositing over a new background.

CJMaskTemporal
    Per-frame detectors/matters (SAM 3.1 tracks, BiRefNet) flicker frame to frame. `max` dilates the
    mask in time (a pixel masked in any frame within +-radius stays masked: inpaint masks never miss
    a frame where the tracker dropped the object), `mean` box-averages it (soft, stable mattes for
    compositing), `median` removes single-frame pops while keeping edges hard. `stable` averages only
    where the window barely changes (edge flicker) and keeps the current frame where the subject
    moved: a plain mean leaves 1/3- and 2/3-alpha ghost copies trailing anyone who moves fast.

CJMatteGate
    BiRefNet mattes the most salient object, not a chosen subject: an empty frame keeps a potted
    plant, and a small far-away person comes out half transparent. Gate it with a tracked subject
    mask (SAM 3.1 text track, e.g. "person"): alpha = max(matte * grow(subject), erode(subject)).
    Outside the grown track nothing survives; inside the eroded track the subject is solid; the band
    between keeps BiRefNet's soft hair/edge alpha.

CJVideoBgComposite
    Pure compositing, no diffusion: frames * alpha + background * (1 - alpha), at the frames'
    resolution. The background is one image or a clip (cycled when shorter), scaled to cover (or
    contain / stretch) the frame. With no background the original frames, blurred, are used (portrait
    style background blur). Optional matte choke + feather, light wrap (blurred background bleeding
    over the subject edge) and a clip-wide colour match of the subject toward the background.
    Everything runs in torch in frame chunks, so it works on CPU and GPU and on long clips.
"""
import torch
import torch.nn.functional as F

_CHUNK = 16


def _gauss_kernel(sigma, device, dtype):
    r = max(1, int(round(sigma * 3)))
    x = torch.arange(-r, r + 1, device=device, dtype=dtype)
    k = torch.exp(-(x * x) / (2 * sigma * sigma))
    return k / k.sum(), r


def blur(x, sigma):
    """Separable gaussian blur of (N, C, H, W); reflect padding."""
    if sigma <= 0:
        return x
    k, r = _gauss_kernel(float(sigma), x.device, x.dtype)
    c = x.shape[1]
    r_h = min(r, x.shape[-1] - 1)
    r_v = min(r, x.shape[-2] - 1)
    kh = k[r - r_h:r + r_h + 1]
    kv = k[r - r_v:r + r_v + 1]
    kh, kv = kh / kh.sum(), kv / kv.sum()
    if r_h > 0:
        x = F.conv2d(F.pad(x, (r_h, r_h, 0, 0), mode="reflect"), kh.view(1, 1, 1, -1).expand(c, 1, 1, -1), groups=c)
    if r_v > 0:
        x = F.conv2d(F.pad(x, (0, 0, r_v, r_v), mode="reflect"), kv.view(1, 1, -1, 1).expand(c, 1, -1, 1), groups=c)
    return x


def erode(m, px):
    """Morphological erosion of (N, 1, H, W) by a (2px+1) square."""
    if px <= 0:
        return m
    return -F.max_pool2d(-m, 2 * px + 1, stride=1, padding=px)


def temporal(mask, mode="max", radius=2, stable_range=0.25):
    """mask (T, H, W) float -> (T, H, W). Window clipped at the clip ends."""
    if radius <= 0 or mask.shape[0] < 2:
        return mask.clone()
    T = mask.shape[0]
    out = torch.empty_like(mask)
    for t in range(T):
        w = mask[max(0, t - radius):min(T, t + radius + 1)]
        if mode == "max":
            out[t] = w.amax(0)
        elif mode == "median":
            out[t] = w.median(0).values
        elif mode == "stable":
            rng = w.amax(0) - w.amin(0)
            out[t] = torch.where(rng < stable_range, w.mean(0), mask[t])
        else:
            out[t] = w.mean(0)
    return out


def _resize_like(m, H, W):
    """(T, h, w) -> (T, H, W) bilinear."""
    if m.shape[-2:] == (H, W):
        return m
    return F.interpolate(m[:, None].float(), size=(H, W), mode="bilinear", align_corners=False)[:, 0]


def gate_matte(matte, subject, grow_px=16, core_px=6):
    """matte (T, H, W) soft alpha, subject (Ts, h, w) tracked mask -> (T, H, W) gated alpha.
    A subject track shorter than the matte holds its last frame; an empty track removes everything."""
    T, H, W = matte.shape
    sub = (_resize_like(subject.float(), H, W) > 0.5).float()
    if sub.shape[0] < T:
        sub = torch.cat([sub, sub[-1:].expand(T - sub.shape[0], -1, -1)], 0)
    sub = sub[:T, None]
    grown = F.max_pool2d(sub, 2 * grow_px + 1, stride=1, padding=grow_px) if grow_px > 0 else sub
    core = erode(sub, core_px)
    return torch.maximum(matte.float().clamp(0, 1) * grown[:, 0], core[:, 0])


def fit_background(bg, h, w, mode="cover"):
    """bg (N, H0, W0, 3) -> (N, h, w, 3)."""
    x = bg.movedim(-1, 1)
    bh, bw = x.shape[-2:]
    if mode == "stretch":
        return F.interpolate(x, size=(h, w), mode="bilinear", align_corners=False, antialias=True).movedim(1, -1)
    s = max(h / bh, w / bw) if mode == "cover" else min(h / bh, w / bw)
    nh, nw = max(1, round(bh * s)), max(1, round(bw * s))
    x = F.interpolate(x, size=(nh, nw), mode="bilinear", align_corners=False, antialias=True)
    if mode == "cover":
        y0, x0 = (nh - h) // 2, (nw - w) // 2
        x = x[..., y0:y0 + h, x0:x0 + w]
    else:  # contain: centre on the background's own blurred, covered copy
        under = fit_background(bg, h, w, "cover").movedim(-1, 1)
        under = blur(under, max(h, w) / 40)
        y0, x0 = (h - nh) // 2, (w - nw) // 2
        under[..., y0:y0 + nh, x0:x0 + nw] = x
        x = under
    return x.movedim(1, -1)


def _stats(x, wts):
    """Weighted per-channel mean/std of x (N, H, W, 3) with weights (N, H, W)."""
    s = wts.sum().clamp_min(1e-6)
    mu = (x * wts[..., None]).sum((0, 1, 2)) / s
    var = (((x - mu) ** 2) * wts[..., None]).sum((0, 1, 2)) / s
    return mu, var.clamp_min(1e-8).sqrt()


def composite(frames, matte, background=None, fit="cover", choke_px=1, feather_px=1.5, light_wrap=0.0,
              wrap_px=12, color_match=0.0, blur_px=24.0, chunk=_CHUNK):
    """frames (T, H, W, 3), matte (T, H, W) with 1 = keep (subject), background (N, h, w, 3) or None.
    Returns (image (T, H, W, 3), alpha (T, H, W))."""
    T, H, W, _ = frames.shape
    matte = matte[..., :H, :W] if matte.shape[-2:] == (H, W) else F.interpolate(
        matte[:, None], size=(H, W), mode="bilinear", align_corners=False)[:, 0]
    Tm = matte.shape[0]
    if Tm < T:
        matte = torch.cat([matte, matte[-1:].expand(T - Tm, -1, -1)], 0)
    bg_fit = None
    if background is not None:
        bg_fit = fit_background(background[..., :3].float(), H, W, fit)

    # clip-wide colour statistics (one transform for the whole clip: no flicker)
    shift = None
    if color_match > 0:
        idx = torch.linspace(0, T - 1, min(T, 8)).round().long()
        fg_s, a_s = frames[idx, ..., :3].float(), (matte[idx] > 0.5).float()
        if background is not None:
            bi = torch.linspace(0, bg_fit.shape[0] - 1, min(bg_fit.shape[0], 8)).round().long()
            ref = bg_fit[bi]
            ref_w = torch.ones(ref.shape[:3])
        else:
            ref, ref_w = fg_s, 1 - a_s
        mu_f, sd_f = _stats(fg_s, a_s)
        mu_b, sd_b = _stats(ref, ref_w)
        # move the mean fully and the contrast half way, then blend by color_match
        sd_t = sd_f + 0.5 * (sd_b - sd_f)
        shift = (mu_f, sd_f, mu_b, sd_t)

    out = torch.empty(T, H, W, 3, dtype=frames.dtype, device=frames.device)
    alpha_out = torch.empty(T, H, W, dtype=frames.dtype, device=frames.device)
    for s in range(0, T, chunk):
        e = min(T, s + chunk)
        fg = frames[s:e, ..., :3].float().movedim(-1, 1)
        a = matte[s:e].float().clamp(0, 1)[:, None]
        a = erode(a, int(choke_px))
        if feather_px > 0:
            a = blur(a, feather_px)
        if bg_fit is None:
            # mask-normalised blur: the subject must not smear into its own blurred background (halo)
            w = erode(1 - (matte[s:e].float()[:, None] > 0.05).float(), 4)   # background, subject grown 4 px
            bw = blur(w, blur_px)
            bg = torch.where(bw > 1e-3, blur(fg * w, blur_px) / bw.clamp_min(1e-3), blur(fg, blur_px))
        else:
            n = bg_fit.shape[0]
            bg = bg_fit[torch.arange(s, e) % n].movedim(-1, 1)
        if shift is not None:
            mu_f, sd_f, mu_b, sd_t = (v.view(1, 3, 1, 1) for v in shift)
            matched = ((fg - mu_f) / sd_f * sd_t + mu_b).clamp(0, 1)
            fg = fg + color_match * (matched - fg)
        if light_wrap > 0:
            edge = blur(1 - a, wrap_px) * a          # inside the subject, near its edge
            fg = fg + light_wrap * edge * (blur(bg, wrap_px) - fg)
        comp = fg * a + bg * (1 - a)
        out[s:e] = comp.clamp(0, 1).movedim(1, -1).to(out.dtype)
        alpha_out[s:e] = a[:, 0].to(alpha_out.dtype)
    return out, alpha_out


class CJMaskTemporal:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "mask": ("MASK",),
            "mode": (["max", "mean", "median", "stable"], {"default": "max",
                     "tooltip": "max = temporal dilation (inpaint masks), mean = soft smoothing (ghosts on fast motion), median = drop single-frame pops, stable = smooth flicker only where nothing moved (mattes)"}),
            "radius": ("INT", {"default": 2, "min": 0, "max": 12, "tooltip": "Frames on each side."}),
        }}

    RETURN_TYPES = ("MASK",)
    FUNCTION = "run"
    CATEGORY = "mask"

    def run(self, mask, mode, radius):
        m = mask if mask.ndim == 3 else mask.reshape(-1, *mask.shape[-2:])
        return (temporal(m.float(), mode, int(radius)),)


class CJMatteGate:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "matte": ("MASK", {"tooltip": "Soft matte (RemoveBackground / BiRefNet)."}),
            "subject": ("MASK", {"tooltip": "Tracked subject mask (SAM 3.1 video track). Only this survives."}),
            "grow_px": ("INT", {"default": 16, "min": 0, "max": 128,
                        "tooltip": "How far outside the track the matte may reach (hair, loose clothing)."}),
            "core_px": ("INT", {"default": 6, "min": 0, "max": 64,
                        "tooltip": "Inside the track eroded by this much the subject is fully solid."}),
        }}

    RETURN_TYPES = ("MASK",)
    FUNCTION = "run"
    CATEGORY = "mask"

    def run(self, matte, subject, grow_px, core_px):
        m = matte if matte.ndim == 3 else matte.reshape(-1, *matte.shape[-2:])
        s = subject if subject.ndim == 3 else subject.reshape(-1, *subject.shape[-2:])
        return (gate_matte(m, s.to(m.device), int(grow_px), int(core_px)),)


class CJVideoBgComposite:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "frames": ("IMAGE", {"tooltip": "Source video frames."}),
            "matte": ("MASK", {"tooltip": "Subject matte, 1 = keep (RemoveBackground / SAM3 mask)."}),
            "fit": (["cover", "contain", "stretch"], {"default": "cover"}),
            "choke_px": ("INT", {"default": 1, "min": 0, "max": 32, "tooltip": "Erode the matte (removes the old background halo)."}),
            "feather_px": ("FLOAT", {"default": 1.5, "min": 0.0, "max": 32.0, "step": 0.5}),
            "light_wrap": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 1.0, "step": 0.05,
                           "tooltip": "Blurred new background bleeding over the subject's edge."}),
            "wrap_px": ("FLOAT", {"default": 12.0, "min": 1.0, "max": 64.0, "step": 1.0}),
            "color_match": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 1.0, "step": 0.05,
                            "tooltip": "Pull the subject's colour toward the background (clip-wide, no flicker)."}),
            "blur_px": ("FLOAT", {"default": 24.0, "min": 0.0, "max": 128.0, "step": 1.0,
                        "tooltip": "Without a background: blur the original background by this much."}),
        }, "optional": {
            "background": ("IMAGE", {"tooltip": "One image or a clip (cycled). Empty = blurred original."}),
        }}

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "alpha")
    FUNCTION = "run"
    CATEGORY = "image/video"

    def run(self, frames, matte, fit, choke_px, feather_px, light_wrap, wrap_px, color_match, blur_px,
            background=None):
        m = matte if matte.ndim == 3 else matte.reshape(-1, *matte.shape[-2:])
        img, a = composite(frames, m.to(frames.device), None if background is None else background.to(frames.device),
                           fit=fit, choke_px=choke_px, feather_px=feather_px, light_wrap=light_wrap,
                           wrap_px=wrap_px, color_match=color_match, blur_px=blur_px)
        return (img, a)


NODE_CLASS_MAPPINGS = {"CJMaskTemporal": CJMaskTemporal, "CJMatteGate": CJMatteGate,
                       "CJVideoBgComposite": CJVideoBgComposite}
NODE_DISPLAY_NAME_MAPPINGS = {
    "CJMatteGate": "Matte Gate (keep only the tracked subject)",
    "CJMaskTemporal": "Mask Temporal Smooth / Dilate (video)",
    "CJVideoBgComposite": "Video Background Composite (matte over new background)",
}

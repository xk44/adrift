"""paste an image EDIT back onto the ORIGINAL photo, at the original's resolution.

Why: instruction-edit models (FIBO 2.0, FLUX.3, Qwen-Image-Edit, Krea 2 edit) re-render every pixel at
~1 MP. Faces drift, fine texture softens, and 10-15 % of the pixels outside the requested change move.
This keeps the original pixels everywhere except where the edit was asked for (and where it really
drew something new near there), and blends at the original's full resolution.

Edit-region alpha, computed at the ORIGINAL resolution:
  gen_up  = edited warped back onto the original's frame (inverse of scale-to-cover + centre crop, or a
            plain stretch); outside the edited image's footprint stays original
  gen_up  = per-channel gain/offset fit so it matches the original where nothing was asked to change
  diff    = box-blur |orig - gen_up|; blobs = diff components > diff_thresh
  near    = region dilated by reach (a relocated arm / hand lands outside the old object's mask)
  keep    = grow(region) | grow(blobs touching near; mostly-outside blobs clipped to near) | grow(new_content)
  keep   |= grow(subject)                    # pose edits: the whole person comes from the edit
  keep   &= ~(protect minus region)          # faces stay original unless the removed object covered them
  alpha   = feather(keep) * footprint
region_match (0..1, off by default): a regenerated region (an inpainted face) drifts a few levels in tone
from the source even when the global fit is perfect, because the trust pixels sit far outside it. The
region's inner rim (the band just inside its edge: cheeks, jaw, hairline) shows the same surface in both
images, so a per-channel mean/std transfer fitted there is applied to the edit inside the region, fading
out past its edge so the feathered seam blends tone-matched pixels.
With no region mask, blobs of at least min_blob_frac of the frame are kept (diff-only mode)."""
import cv2
import numpy as np
import torch


def _disk(r):
    r = max(int(r), 0)
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def _dilate(m, r):
    return cv2.dilate(m.astype(np.uint8), _disk(r)).astype(bool) if r > 0 else m.astype(bool)


def _erode(m, r):
    return cv2.erode(m.astype(np.uint8), _disk(r)).astype(bool) if r > 0 else m.astype(bool)


def fill_holes(m):
    """Fill enclosed holes (glasses, open mouth) so a face mask covers the whole face."""
    m = m.astype(np.uint8)
    h, w = m.shape
    flood = np.pad(m, 1).copy()
    cv2.floodFill(flood, np.zeros((h + 4, w + 4), np.uint8), (0, 0), 1)
    return m.astype(bool) | ~flood[1:-1, 1:-1].astype(bool)


def warp_matrix(src_w, src_h, gen_w, gen_h, fit="crop"):
    """2x3 affine mapping EDITED pixel coords -> ORIGINAL pixel coords.
    crop: the edit model scaled the original to cover gen_w x gen_h and centre-cropped (FIBO 2.0, H3).
    stretch: the edit model resized the original to gen_w x gen_h (FLUX / Qwen 'keep resolution')."""
    if fit == "stretch":
        return np.float32([[src_w / gen_w, 0, 0], [0, src_h / gen_h, 0]])
    s = max(gen_w / src_w, gen_h / src_h)   # original -> covering size
    x0 = (src_w * s - gen_w) / 2
    y0 = (src_h * s - gen_h) / 2
    return np.float32([[1 / s, 0, x0 / s], [0, 1 / s, y0 / s]])


def to_src(img, M, src_wh, interp=cv2.INTER_LANCZOS4, border=cv2.BORDER_REPLICATE):
    return cv2.warpAffine(img, M, src_wh, flags=interp, borderMode=border, borderValue=0)


def align_affine(src, gen_up, valid, max_side=1024):
    """Similarity transform (2x3, gen_up pixel -> src pixel) that registers a drifted edit onto the original,
    or None when the edit is already aligned or no trustworthy fit exists. Some edit models (Qwen-Image 2.1
    turbo) re-frame the shot by ~1-3 % zoom, a few px shift and a fraction of a degree; pasting that back
    unregistered doubles every edge at the seam. ORB features on `valid` pixels (outside the edit region),
    RANSAC, and tight bounds so a real content change is never 'aligned' away."""
    H, W = src.shape[:2]
    k = min(1.0, max_side / max(H, W))
    small = lambda im: cv2.resize(im, (max(1, int(W * k)), max(1, int(H * k))), interpolation=cv2.INTER_AREA)
    gray = lambda im: cv2.cvtColor(small(im), cv2.COLOR_RGB2GRAY)
    m = small(valid.astype(np.uint8) * 255)
    orb = cv2.ORB_create(4000)
    k1, d1 = orb.detectAndCompute(gray(gen_up), m)
    k2, d2 = orb.detectAndCompute(gray(src), m)
    if d1 is None or d2 is None or len(k1) < 40 or len(k2) < 40:
        return None
    matches = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(d1, d2)
    if len(matches) < 40:
        return None
    p1 = np.float32([k1[x.queryIdx].pt for x in matches]) / k
    p2 = np.float32([k2[x.trainIdx].pt for x in matches]) / k
    A, inl = cv2.estimateAffinePartial2D(p1, p2, method=cv2.RANSAC, ransacReprojThreshold=3.0 / k)
    if A is None or inl is None or int(inl.sum()) < 30 or inl.mean() < 0.25:
        return None
    scale = float(np.hypot(A[0, 0], A[1, 0]))
    rot = float(np.degrees(np.arctan2(A[1, 0], A[0, 0])))
    # how far the transform moves the frame's corners (px): identity-ish -> leave the exact warp alone
    corners = np.float32([[0, 0, 1], [W, 0, 1], [0, H, 1], [W, H, 1]])
    move = float(np.abs(corners @ A.T - corners[:, :2]).max())
    if abs(scale - 1) > 0.08 or abs(rot) > 3 or move > 0.12 * max(H, W) or move < 1.0:
        return None
    return A.astype(np.float32)


def color_match(src, gen, trust):
    """Per-channel gain/offset so gen matches src on `trust` pixels (where nothing should have changed).
    Fit on low-passed images (the edit model's softening / grain must not dilute the slope) and ridge the
    gain toward 1, so a near-flat channel (overcast sky) gets an offset, not a wild gain."""
    if trust.sum() < 500:
        return gen
    step = max(1, int(np.sqrt(trust.sum() / 200_000)))
    t = trust[::step, ::step]
    gs, ss = cv2.blur(gen, (7, 7))[::step, ::step], cv2.blur(src, (7, 7))[::step, ::step]
    out = gen.astype(np.float32)
    for c in range(3):
        x = gs[..., c][t].astype(np.float64)
        y = ss[..., c][t].astype(np.float64)
        xc, yc = x - x.mean(), y - y.mean()
        lam = x.size * 100.0                      # prior: gain 1 unless the channel spans well over ~10 levels
        g = float(np.clip(((xc * yc).sum() + lam) / ((xc * xc).sum() + lam), 0.8, 1.25))
        o = float(np.clip(y.mean() - g * x.mean(), -40, 40))
        out[..., c] = out[..., c] * g + o
    return np.clip(out, 0, 255)


def rim_band(region, width):
    """The band of `region` within `width` px of its edge (inside it)."""
    return region & ~_erode(region, width)


def region_tone_fit(src, gen, band, lam=25.0, robust_q=75.0):
    """Per-channel (gain, offset) mapping gen -> src from mean/std on `band` (low-passed, robust).
    Pixels whose content really changed (the jaw moved) are dropped: only band pixels whose difference
    from the band's median shift is at or below the robust_q percentile count (centred on the median, so
    the drift itself does not bias the selection). The gain is ridged toward 1 (lam = variance prior,
    levels^2) and clipped, so a flat band gets an offset only. Returns None when the band is too small."""
    if band.sum() < 200:
        return None
    gs = cv2.blur(gen, (5, 5)).astype(np.float64)
    ss = cv2.blur(src, (5, 5)).astype(np.float64)
    diff = gs - ss
    d = np.abs(diff - np.median(diff[band], axis=0)).mean(-1)
    sel = band & (d <= np.percentile(d[band], robust_q))
    if sel.sum() < 100:
        sel = band
    fit = []
    for c in range(3):
        x, y = gs[..., c][sel], ss[..., c][sel]
        g = float(np.clip(np.sqrt((y.var() + lam) / (x.var() + lam)), 0.85, 1.18))
        o = float(np.clip(y.mean() - g * x.mean(), -30, 30))
        fit.append((g, o))
    return fit


def region_tone_match(src, gen_up, region, px, strength=1.0, band_px=24, fade_px=12):
    """gen_up with its tone matched to src inside `region` (see region_match in the module doc).
    Full correction inside the region, fading out over ~fade_px past its edge."""
    if strength <= 0 or not region.any():
        return gen_up
    fit = region_tone_fit(src, gen_up, rim_band(region, max(2, int(band_px * px))))
    if fit is None:
        return gen_up
    g32 = gen_up.astype(np.float32)
    matched = np.empty_like(g32)
    for c, (g, o) in enumerate(fit):
        matched[..., c] = g32[..., c] * g + o
    w = region.astype(np.float32)
    if fade_px:
        w = np.maximum(w, cv2.GaussianBlur(_dilate(region, int(fade_px * px)).astype(np.float32), (0, 0),
                                           max(1.0, fade_px * px)))
    w = (np.clip(w, 0, 1) * float(min(strength, 1.0)))[..., None]
    return np.clip(g32 * (1 - w) + matched * w + 0.5, 0, 255).astype(np.uint8)


def paste_back(src, gen, region=None, new_content=None, protect=None, fit="crop", diff_thresh=22.0,
               reach_frac=0.18, grow_px=12, feather_px=6, min_blob_frac=0.001, match_color=True, subject=None,
               protect_mode="keep", core_frac=0.16, relight_frac=0.06, region_match=0.0, match_band_px=24,
               align=False, strict=False):
    """src: HxWx3 uint8 original. gen: hxwx3 uint8 edit. region/protect: HxW bool on the original (or None).
    new_content: hxw bool on the EDITED image (or None). subject: HxW bool on the original, a body whose pose the
    edit may change (SAM 'person'); taken from the edit like new_content, but protect still wins inside it.
    protect_mode: 'keep' = protected pixels stay the original's exactly; 'relight' = the protected face's inner
    core keeps the original's detail under the edit's lighting, its rim/hair comes from the edit (no halo when
    the edit changed the light or the background behind the head).
    Returns (composite uint8, alpha float32 HxW)."""
    H, W = src.shape[:2]
    h, w = gen.shape[:2]
    M = warp_matrix(W, H, w, h, fit)
    gen_up = to_src(gen, M, (W, H))
    footprint = to_src(np.ones((h, w), np.float32), M, (W, H), cv2.INTER_LINEAR, cv2.BORDER_CONSTANT) > 0.999
    short = min(H, W)
    px = short / 880.0                                   # knobs are tuned at an 880 px short side
    region = np.zeros((H, W), bool) if region is None else region.astype(bool)
    have_region = bool(region.any())
    if align:
        busy = region if subject is None else (region | subject.astype(bool))
        A = align_affine(src, gen_up, footprint & ~_dilate(busy, int(40 * px)))
        if A is not None:
            gen_up = to_src(gen_up, A, (W, H))
            footprint &= to_src(np.ones((H, W), np.float32), A, (W, H), cv2.INTER_LINEAR,
                                cv2.BORDER_CONSTANT) > 0.999

    if match_color:
        rough = np.abs(cv2.blur(src, (9, 9)).astype(np.float32) - cv2.blur(gen_up, (9, 9)).astype(np.float32)).mean(-1)
        busy = region if subject is None else (region | subject.astype(bool))
        trust = footprint & ~_dilate(busy, int(40 * px)) & (rough < 30)
        gen_up = color_match(src, gen_up, trust).astype(np.uint8)
    if region_match > 0 and have_region:
        gen_up = region_tone_match(src, gen_up, region, px, region_match, match_band_px, feather_px)

    k = max(3, int(21 * px) | 1)
    d = cv2.blur(np.abs(src.astype(np.float32) - gen_up.astype(np.float32)).mean(-1), (k, k))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(((d > diff_thresh) & footprint).astype(np.uint8), 8)
    sizes = stats[:, cv2.CC_STAT_AREA]
    big = np.zeros(n, bool)
    big[1:] = sizes[1:] > min_blob_frac * H * W
    if have_region:
        near = _dilate(region, int(reach_frac * short))
        touch = np.zeros(n, bool)
        touch[np.unique(lab[near])] = True
        big &= touch
    blobs = big[lab]
    if have_region:
        # A blob mostly inside reach (a relocated arm) is kept whole; one mostly OUTSIDE it is a re-rendered
        # background that merely touches the zone (a lantern row, a crowd) and is clipped to the zone.
        inside = np.bincount(lab[near], minlength=n) / np.maximum(sizes, 1)
        sprawl = big & (inside < 0.5)
        blobs &= ~(sprawl[lab] & ~near)
        if strict:
            # user-painted masks: nothing beyond reach of the region; a blob that spills out of it (the edit
            # also recoloured a passer-by touching the mask) is clipped, not kept whole.
            blobs &= near

    keep = _dilate(region, int(grow_px * px)) | _dilate(blobs, int(8 * px))
    if new_content is not None and new_content.any():
        nc = to_src(new_content.astype(np.float32), M, (W, H), cv2.INTER_LINEAR, cv2.BORDER_CONSTANT) > 0.5
        keep |= _dilate(nc, int(10 * px))
    if subject is not None and subject.any():
        keep |= _dilate(subject.astype(bool), int(10 * px))
    pr = None
    if protect is not None and protect.any():
        pr = fill_holes(cv2.morphologyEx(protect.astype(np.uint8), cv2.MORPH_CLOSE, _disk(int(15 * px))))
        if protect_mode == "keep":
            keep &= ~(_erode(pr, int(3 * px)) & ~region)
    alpha = keep.astype(np.float32)
    if feather_px:
        alpha = cv2.GaussianBlur(alpha, (0, 0), feather_px * px)
    alpha *= footprint
    a = alpha[..., None]
    out = gen_up.astype(np.float32) * a + src.astype(np.float32) * (1 - a)
    if pr is not None and protect_mode == "relight":
        out = _relight_cores(out, src, gen_up, pr & ~region, alpha, core_frac, relight_frac)
    return (out + 0.5).astype(np.uint8), alpha


def _relight_cores(out, src, gen_up, pr, alpha, core_frac=0.16, relight_frac=0.06):
    """Per protected component (a face): the inner core keeps the ORIGINAL's detail (identity) but takes the
    edit's low frequencies (lighting), so an original face sits in an edited scene without a cut-out halo:
    hair and the head outline come from the edit, the seam lies on skin where both agree.
    Applied only as far as the edit is pasted there (alpha), so untouched faces stay bit-exact."""
    H, W = pr.shape
    n, lab, stats, _ = cv2.connectedComponentsWithStats(pr.astype(np.uint8), 8)
    s32, g32 = src.astype(np.float32), gen_up.astype(np.float32)
    for i in range(1, n):
        x, y, w, h = stats[i, :4]
        size = max(w, h)
        if size < 8:
            continue
        p = int(size * 0.6)
        ys, xs = slice(max(0, y - p), min(H, y + h + p)), slice(max(0, x - p), min(W, x + w + p))
        core = _erode(lab[ys, xs] == i, int(size * core_frac))
        if not core.any():
            continue
        sig = max(1.0, size * relight_frac)
        rel = np.clip(s32[ys, xs] + cv2.GaussianBlur(g32[ys, xs], (0, 0), sig)
                      - cv2.GaussianBlur(s32[ys, xs], (0, 0), sig), 0, 255)
        ac = (cv2.GaussianBlur(core.astype(np.float32), (0, 0), max(1.0, size * 0.05)) * alpha[ys, xs])[..., None]
        out[ys, xs] = out[ys, xs] * (1 - ac) + rel * ac
    return out


def _img(t):
    return t.clamp(0, 1).mul(255).round().to(torch.uint8).cpu().numpy()


def _mask(m, i, hw):
    """MASK tensor (B,H,W) or (H,W) -> bool HxW at hw=(H,W), frame i (clamped); union of a batch of
    per-instance masks is the caller's job (SAM3_Detect individual_masks=False already unions)."""
    if m is None:
        return None
    m = m if m.dim() == 3 else m[None]
    a = m[min(i, m.shape[0] - 1)].float().cpu().numpy()
    if a.shape != tuple(hw):
        a = cv2.resize(a, (hw[1], hw[0]), interpolation=cv2.INTER_LINEAR)
    return a > 0.5


class CJImagePasteBack:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "original": ("IMAGE", {"tooltip": "The source photo at full resolution (LoadImage)."}),
            "edited": ("IMAGE", {"tooltip": "The edit model's output (any size; batch ok)."}),
        }, "optional": {
            "region": ("MASK", {"tooltip": "Where the edit was asked for, on the ORIGINAL (e.g. SAM3 'umbrella')."}),
            "new_content": ("MASK", {"tooltip": "New content on the EDITED image (e.g. SAM3 'arm' on the edit)."}),
            "protect": ("MASK", {"tooltip": "Keep original here unless the region covers it (e.g. SAM3 'face')."}),
            "fit": (["crop", "stretch"], {"default": "crop", "tooltip": "crop: edit = scale-to-cover + centre crop "
                                          "(FIBO 2.0). stretch: edit = plain resize (FLUX / Qwen keep-resolution)."}),
            "diff_thresh": ("FLOAT", {"default": 22.0, "min": 1.0, "max": 255.0, "step": 0.5}),
            "reach": ("FLOAT", {"default": 0.18, "min": 0.0, "max": 1.0, "step": 0.01,
                                "tooltip": "How far from the region (fraction of the short side) a changed blob may "
                                           "start and still be kept (a lowered arm, a moved hand)."}),
            "grow_px": ("INT", {"default": 12, "min": 0, "max": 256}),
            "feather_px": ("INT", {"default": 6, "min": 0, "max": 128}),
            "min_blob": ("FLOAT", {"default": 0.001, "min": 0.0, "max": 0.5, "step": 0.0005}),
            "color_match": ("BOOLEAN", {"default": True}),
            "subject": ("MASK", {"tooltip": "Pose-change edits: the person on the ORIGINAL (SAM3 'person'). Their body comes "
                                            "from the edit (pair with new_content = person on the edit); protect still keeps the face."}),
            "protect_mode": (["relight", "keep"], {"default": "relight", "tooltip": "relight: keep the original face's "
                             "detail under the edit's lighting, hair/outline from the edit (no cut-out halo). keep: "
                             "protected pixels stay exactly original."}),
            "region_match": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05, "tooltip":
                             "Match the edit's tone to the original inside the region (mean/std fitted on the "
                             "region's inner rim). For inpainted video faces that drift a few levels per frame."}),
            "match_band_px": ("INT", {"default": 24, "min": 2, "max": 128, "tooltip":
                              "Width of the inner rim region_match fits on (at an 880 px short side)."}),
            "align": ("BOOLEAN", {"default": True, "tooltip": "Register an edit that drifted (zoom / shift / "
                      "slight rotation, e.g. Qwen-Image 2.1) onto the original before pasting, so the seam "
                      "does not double edges. Skipped when the edit is already aligned."}),
            "strict": ("BOOLEAN", {"default": False, "tooltip": "Clip every changed blob to the region + reach "
                       "(user-painted masks: the edit must stay inside them). Off: a blob mostly inside the "
                       "region is kept whole (a moved jaw / arm)."}),
        }}

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "alpha")
    FUNCTION = "run"
    CATEGORY = "image/postprocessing"

    def run(self, original, edited, region=None, new_content=None, protect=None, fit="crop", diff_thresh=22.0,
            reach=0.18, grow_px=12, feather_px=6, min_blob=0.001, color_match=True, subject=None, protect_mode="relight",
            region_match=0.0, match_band_px=24, align=True, strict=False):
        srcs, gens = _img(original), _img(edited)
        outs, alphas = [], []
        for i in range(gens.shape[0]):
            src = srcs[min(i, srcs.shape[0] - 1)][..., :3]
            gen = gens[i][..., :3]
            hw, ghw = src.shape[:2], gen.shape[:2]
            out, a = paste_back(src, gen, _mask(region, i, hw), _mask(new_content, i, ghw), _mask(protect, i, hw),
                                fit, diff_thresh, reach, grow_px, feather_px, min_blob, color_match, _mask(subject, i, hw),
                                protect_mode, region_match=region_match, match_band_px=match_band_px,
                                align=align, strict=strict)
            outs.append(torch.from_numpy(out.astype(np.float32) / 255.0))
            alphas.append(torch.from_numpy(a))
        return torch.stack(outs), torch.stack(alphas)


NODE_CLASS_MAPPINGS = {"CJImagePasteBack": CJImagePasteBack}
NODE_DISPLAY_NAME_MAPPINGS = {"CJImagePasteBack": "Paste Edit Back Onto Original (full res)"}

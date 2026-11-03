"""paste a generated subject back onto the ORIGINAL source video, at source resolution.

Why: latent video models (H3 etc.) re-render every pixel through the VAE, so subtitles, watermarks and
fine background detail degrade even where the edit mask kept the source latents. This keeps the source
pixels everywhere except the edited subject, and writes the mp4 itself with the source audio
stream-copied (bit-exact) and proper interleave + faststart, which SaveVideo doesn't do (that broke
Discord playback partway through).

Alpha per frame, computed at the generated resolution:
  allowed = temporal-max(expanded_mask, +-t_radius)     # where the model was permitted to change
  changed = blur|gen - src| > diff_thresh, inside allowed # where it actually changed
  alpha   = feather(dilate(changed | raw_mask, grow_px)) clipped to allowed
  text    = bright, unsaturated pixels in the source's bottom band -> always source (subtitles)
Then gen and alpha are warped to source resolution (the inverse of H3 prepare's scale-to-cover
followed by a centre crop) and blended there."""
import os
import subprocess
import tempfile

import cv2
import numpy as np

# Colour handling for the raw-RGB pipes (one copy per module so each loads on its own):
# - decode: full-chroma bicubic yuv->rgb (+3 dB PSNR vs the default chroma upsampling on a 4:2:0 clip),
#   matrix from the stream's tags (untagged = BT.601, same as ComfyUI's own decode)
# - encode: BT.709 matrix + tags, so browsers (which show untagged HD as BT.709) and tag-aware decoders
#   both see the right colours (untagged BT.601 output played back as BT.709 measured -10 dB).
RGB_DECODE_VF = "scale=flags=bicubic+accurate_rnd+full_chroma_int,format=rgb24"
BT709_ENCODE_VF = ("scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,"
                   "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv")


def _disk(r):
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def temporal_max(mask, r):
    out = mask.copy()
    for d in range(1, r + 1):
        out[d:] |= mask[:-d]
        out[:-d] |= mask[d:]
    return out


def allowed_masks(raw, allow_px=64, t_radius=3):
    k = _disk(allow_px)
    return temporal_max(np.stack([cv2.dilate(m.astype(np.uint8), k) for m in raw]).astype(bool), t_radius)


def cover_crop_geometry(src_w, src_h, gen_w, gen_h):
    """Mirror ffmpeg scale=w=ceil(max(W,H*dar)):h=ceil(max(H,W/dar)) + centre crop (LabsH3PrepareVideo)."""
    dar = src_w / src_h
    sw = int(np.ceil(max(gen_w, gen_h * dar) - 1e-6))
    sh = int(np.ceil(max(gen_h, gen_w / dar) - 1e-6))
    return sw / src_w, (sw - gen_w) // 2, (sh - gen_h) // 2, (sw, sh)


class PasteBack:
    def __init__(self, src_w, src_h, gen_w, gen_h, diff_thresh=14.0, grow_px=10, feather_px=6, protect_text=True,
                 text_min=205, text_band=0.22):
        self.src_wh, self.gen_wh = (src_w, src_h), (gen_w, gen_h)
        self.scale, self.x0, self.y0, self.scaled = cover_crop_geometry(src_w, src_h, gen_w, gen_h)
        s = 1.0 / self.scale
        self.M = np.float32([[s, 0, self.x0 * s], [0, s, self.y0 * s]])
        self.diff_thresh, self.grow, self.feather = diff_thresh, grow_px, feather_px
        self.protect_text, self.text_min, self.text_band = protect_text, text_min, text_band

    def src_to_gen(self, src):
        sw, sh = self.scaled
        gw, gh = self.gen_wh
        return cv2.resize(src, (sw, sh), interpolation=cv2.INTER_AREA)[self.y0:self.y0 + gh, self.x0:self.x0 + gw]

    def alpha_gen(self, src_g, gen, subj, allowed):
        a = cv2.GaussianBlur(src_g.astype(np.float32), (0, 0), 2.5)
        b = cv2.GaussianBlur(gen.astype(np.float32), (0, 0), 2.5)
        changed = (np.abs(a - b).mean(-1) > self.diff_thresh) & allowed
        changed = cv2.morphologyEx(changed.astype(np.uint8), cv2.MORPH_OPEN, _disk(2))
        m = cv2.dilate((changed.astype(bool) | subj).astype(np.uint8), _disk(self.grow)).astype(bool) & allowed
        alpha = m.astype(np.float32)
        if self.feather:
            alpha = cv2.GaussianBlur(alpha, (0, 0), self.feather) * allowed
        return alpha

    def text_alpha(self, src):
        t = np.zeros(src.shape[:2], np.float32)
        y = int(src.shape[0] * (1 - self.text_band))
        band = src[y:].astype(np.int16)
        core = (band.min(-1) >= self.text_min) & ((band.max(-1) - band.min(-1)) < 40)
        t[y:] = cv2.GaussianBlur(cv2.dilate(core.astype(np.uint8), _disk(1)).astype(np.float32), (0, 0), 0.8)
        return np.clip(t * 1.5, 0, 1)

    def frame(self, src, gen, subj, allowed):
        a_g = self.alpha_gen(self.src_to_gen(src), gen, subj, allowed)
        if a_g.max() <= 0:
            return src
        W, H = self.src_wh
        gen_up = cv2.warpAffine(gen, self.M, (W, H), flags=cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REPLICATE)
        a = cv2.warpAffine(a_g, self.M, (W, H), flags=cv2.INTER_LINEAR, borderValue=0)
        if self.protect_text:
            a = a * (1 - self.text_alpha(src))
        a = a[..., None]
        return (gen_up.astype(np.float32) * a + src.astype(np.float32) * (1 - a) + 0.5).astype(np.uint8)


def probe_wh(path):
    o = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                        "-of", "csv=p=0", path], capture_output=True, text=True, check=True).stdout.strip().split(",")
    return int(o[0]), int(o[1])


def source_frames_24(path, w, h, upscale=False):
    """Same resample as LabsH3PrepareVideo (fps=24 round=near, eof round) at native resolution, or Lanczos-scaled
    to (w,h) when upscale (output_res='frames': composite at the hi-res frames' detail level)."""
    up = f"scale={w}:{h}:flags=lanczos," if upscale else ""
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-map", "0:v:0",
                          "-vf", f"setpts=PTS-STARTPTS,fps=fps=24:round=near:eof_action=round,{up}{RGB_DECODE_VF}",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    try:
        while True:
            b = p.stdout.read(w * h * 3)
            if len(b) < w * h * 3:
                return
            yield np.frombuffer(b, np.uint8).reshape(h, w, 3)
    finally:
        p.kill()
        p.wait()


def output_wh(src_w, src_h, gen_w, gen_h, output_res="source"):
    """'source' keeps the source size; 'frames' upscales the source (never down) to the frames' detail level."""
    k = cover_crop_geometry(src_w, src_h, gen_w, gen_h)[0]
    if output_res != "frames" or k <= 1.01:
        return src_w, src_h, False
    return int(round(src_w * k / 2)) * 2, int(round(src_h * k / 2)) * 2, True


def composite_to_mp4(src_path, gen_frames, raw, expanded, out_path, crf=17, t_radius=3, output_res="source", **kw):
    """gen_frames: iterable/array of (H,W,3) uint8 at gen res; raw/expanded: (T,H,W) bool. Returns frame count."""
    T, gh, gw = raw.shape
    sw, sh, upscale = output_wh(*probe_wh(src_path), gw, gh, output_res)
    allowed = temporal_max(expanded, t_radius)
    pb = PasteBack(sw, sh, gw, gh, **kw)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
                            "-s", f"{sw}x{sh}", "-r", "24", "-i", "-", "-i", src_path,
                            "-map", "0:v", "-map", "1:a:0?", "-vf", BT709_ENCODE_VF, "-c:v", "libx264", "-preset", "slow", "-crf", str(crf),
                            "-pix_fmt", "yuv420p", "-c:a", "copy", "-shortest", "-movflags", "+faststart", out_path],
                           stdin=subprocess.PIPE)
    n = 0
    try:
        for i, (s, g) in enumerate(zip(source_frames_24(src_path, sw, sh, upscale), gen_frames)):
            if i >= T:
                break
            enc.stdin.write(pb.frame(s, g, raw[i], allowed[i]).tobytes())
            n += 1
    finally:
        enc.stdin.close()
        if enc.wait() != 0:
            raise RuntimeError(f"ffmpeg encode failed for {out_path}")
    if n != T:
        raise ValueError(f"source yielded {n} frames at 24 fps, generated/mask timeline is {T}")
    return n


def scale_masks(raw, exp, fw, fh):
    """Resize (T,h,w) bool masks to (fw,fh); frames must keep the draft aspect (CJRegenAlign output)."""
    T, h, w = raw.shape
    if abs(fw / fh - w / h) > 0.01 * (w / h):
        raise ValueError(f"frames {fw}x{fh} don't match the mask aspect {w}x{h}; align hi-res frames first")
    up = lambda m: np.stack([cv2.resize(f.astype(np.uint8), (fw, fh), interpolation=cv2.INTER_LINEAR) > 0
                             for f in m]) if len(m) else m.reshape(0, fh, fw)
    return up(raw), up(exp), fw / w


def masks_to_source_geometry(raw, exp, src_w, src_h, fw, fh):
    """Warp (T,gh,gw) gen-geometry masks (H3 prepare = cover-scale + centre crop of the source) onto frames that
    are in SOURCE geometry at (fw,fh) (e.g. a 2K regen of an already pasted-back draft). Returns masks + scale."""
    T, gh, gw = raw.shape
    if abs(fw / fh - src_w / src_h) > 0.01 * (src_w / src_h):
        raise ValueError(f"frames {fw}x{fh} match neither the mask aspect {gw}x{gh} nor the source {src_w}x{src_h}")
    M = PasteBack(fw, fh, gw, gh).M
    warp = lambda m: np.stack([cv2.warpAffine(f.astype(np.float32), M, (fw, fh), flags=cv2.INTER_LINEAR,
                                              borderValue=0) > .5 for f in m]) if len(m) else m.reshape(0, fh, fw)
    return warp(raw), warp(exp), 1.0 / PasteBack(fw, fh, gw, gh).scale


def regen_align_maps(gw, gh, pw, ph, fw, fh):
    """Affine (2x3, dst->src) mapping hi-res output pixels (draft geometry, scale k) to Open-H3-Regenerate frames.

    Regenerate: draft (gw,gh) cover-scaled to (sw,sh) + centre-cropped to the prepared (pw,ph); latent upscaled
    (stretch) to the computed (cw,ch); Finish trims 1088->1080 / 2176->2160 on the short side to (fw,fh)."""
    trim_inv = {1080: 1088, 2160: 2176}
    cw, ch = fw, fh
    if fh > fw and fw in trim_inv:
        cw = trim_inv[fw]
    elif fw > fh and fh in trim_inv:
        ch = trim_inv[fh]
    scale = max(pw / gw, ph / gh)
    sw, sh = max(pw, round(gw * scale)), max(ph, round(gh * scale))
    x0, y0 = (sw - pw) // 2, (sh - ph) // 2
    tx, ty = (cw - fw) // 2, (ch - fh) // 2
    ax, ay = sw / gw * cw / pw, sh / gh * ch / ph      # regen px per draft px
    k = min(ax, ay)
    ow, oh = int(round(gw * k / 2)) * 2, int(round(gh * k / 2)) * 2
    kx, ky = ow / gw, oh / gh
    # pixel centres: output X+.5 -> draft (X+.5)/kx -> regen ((X+.5)/kx*sw/gw - x0)*cw/pw - tx, index -.5
    M = np.float32([[ax / kx, 0, ax * 0.5 / kx - x0 * cw / pw - tx - 0.5],
                    [0, ay / ky, ay * 0.5 / ky - y0 * ch / ph - ty - 0.5]])
    return M, ow, oh


class CJRegenAlign:
    """Map Open-H3-Regenerate 2K frames back onto the draft's geometry (no crop, no aspect change), at the regen's
    detail scale. Pixels the regen cropped away (prepare's cover-crop) are filled from the upscaled draft. The
    output feeds CJPasteBackSave.frames with the draft-res masks unchanged (they are scaled to match)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "regen": ("IMAGE", {"tooltip": "Open-H3 Regenerate Finish Frames output."}),
            "draft": ("IMAGE", {"tooltip": "The frames that went into Open-H3 Regenerate Prepare Draft."}),
            "prepared_width": ("INT", {"default": 1024, "min": 32, "max": 8192}),
            "prepared_height": ("INT", {"default": 576, "min": 32, "max": 8192}),
        }}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = "image/video"

    def run(self, regen, draft, prepared_width, prepared_height):
        import torch
        T = min(len(regen), len(draft))
        gh, gw = int(draft.shape[1]), int(draft.shape[2])
        fh, fw = int(regen.shape[1]), int(regen.shape[2])
        M, ow, oh = regen_align_maps(gw, gh, prepared_width, prepared_height, fw, fh)
        flags = cv2.INTER_LANCZOS4 | cv2.WARP_INVERSE_MAP
        cover = cv2.warpAffine(np.ones((fh, fw), np.float32), M, (ow, oh), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                               borderValue=0)
        cover = np.clip((cover - 0.5) * 2, 0, 1)
        if cover.min() < 1:
            cover = cv2.GaussianBlur(cover, (0, 0), max(1.0, ow / gw)) * (cover > 0)
        cover = cover[..., None]
        out = torch.empty((T, oh, ow, 3), dtype=torch.float32)
        for i in range(T):
            r = regen[i, :, :, :3].clamp(0, 1).cpu().numpy().astype(np.float32)
            a = cv2.warpAffine(r, M, (ow, oh), flags=flags, borderMode=cv2.BORDER_REPLICATE)
            if cover.min() < 1:
                d = cv2.resize(draft[i, :, :, :3].cpu().numpy().astype(np.float32), (ow, oh),
                               interpolation=cv2.INTER_CUBIC)
                a = a * cover + d * (1 - cover)
            out[i] = torch.from_numpy(np.clip(a, 0, 1))
        return (out,)


class CJPasteBackSave:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "frames": ("IMAGE", {"tooltip": "Generated frames (e.g. H3RelayFinishWindows.frames)."}),
            "source": ("VIDEO", {"tooltip": "The ORIGINAL LoadVideo (not the prepared one)."}),
            "raw_mask": ("MASK", {"tooltip": "H3RelayLoadMask raw_person_mask"}),
            "expanded_mask": ("MASK", {"tooltip": "H3RelayLoadMask expanded_person_mask (what the model could change)"}),
            "filename_prefix": ("STRING", {"default": "h3-relay/pasteback"}),
        }, "optional": {
            "crf": ("INT", {"default": 17, "min": 0, "max": 51}),
            "diff_thresh": ("FLOAT", {"default": 14.0, "min": 0.0, "max": 255.0, "step": 0.5}),
            "grow_px": ("INT", {"default": 10, "min": 0, "max": 128}),
            "feather_px": ("INT", {"default": 6, "min": 0, "max": 64}),
            "t_radius": ("INT", {"default": 3, "min": 0, "max": 24}),
            "protect_text": ("BOOLEAN", {"default": True}),
            "output_res": (["source", "frames"], {"default": "source", "tooltip":
                           "frames: upscale the source to the generated frames' detail (2K finish) instead of "
                           "downscaling the frames to the source."}),
        }}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("path",)
    OUTPUT_NODE = True
    FUNCTION = "run"
    CATEGORY = "image/video"

    def run(self, frames, source, raw_mask, expanded_mask, filename_prefix, crf=17, diff_thresh=14.0, grow_px=10,
            feather_px=6, t_radius=3, protect_text=True, output_res="source"):
        import folder_paths
        T = min(len(frames), len(raw_mask))
        raw = raw_mask[:T].cpu().numpy() > .5
        exp = expanded_mask[:T].cpu().numpy() > .5
        fh, fw = int(frames.shape[1]), int(frames.shape[2])
        mh, mw = raw.shape[1:]
        mask_aspect_ok = abs(fw / fh - mw / mh) <= 0.01 * (mw / mh)
        if (fh, fw) != (mh, mw) and mask_aspect_ok:
            # hi-res frames (CJRegenAlign of gen-geometry draft) over draft-res masks: scale masks + pixel params
            raw, exp, k = scale_masks(raw, exp, fw, fh)
            grow_px, feather_px = int(round(grow_px * k)), int(round(feather_px * k))
        gen = (frames[i].clamp(0, 1).mul(255).round().to(dtype=__import__("torch").uint8).cpu().numpy() for i in range(T))
        full, name, counter, sub, _ = folder_paths.get_save_image_path(filename_prefix, folder_paths.get_output_directory())
        os.makedirs(full, exist_ok=True)
        fname = f"{name}_{counter:05}_.mp4"
        out = os.path.join(full, fname)
        with tempfile.TemporaryDirectory(prefix="cj-pasteback-") as tmp:
            src = source.get_stream_source()
            start, duration = source.get_active_trim_window()
            if not isinstance(src, str) or start or duration or getattr(source, "_VideoFromFile__crop", None):
                src = os.path.join(tmp, "source.mkv")
                source.save_to(src)
            if not mask_aspect_ok:
                # frames are in SOURCE geometry (regen of a pasted-back draft): move masks there, composite 1:1
                raw, exp, k = masks_to_source_geometry(raw, exp, *probe_wh(src), fw, fh)
                grow_px, feather_px = int(round(grow_px * k)), int(round(feather_px * k))
                output_res = "frames"
            composite_to_mp4(src, gen, raw, exp, out, crf=crf, t_radius=t_radius, diff_thresh=diff_thresh,
                             grow_px=grow_px, feather_px=feather_px, protect_text=protect_text, output_res=output_res)
        return {"ui": {"images": [{"filename": fname, "subfolder": sub, "type": "output"}], "animated": (True,)},
                "result": (out,)}


NODE_CLASS_MAPPINGS = {"CJPasteBackSave": CJPasteBackSave, "CJRegenAlign": CJRegenAlign}
NODE_DISPLAY_NAME_MAPPINGS = {"CJPasteBackSave": "Paste Back Onto Source + Save (source audio)",
                              "CJRegenAlign": "Align 2K Regenerate To Draft"}

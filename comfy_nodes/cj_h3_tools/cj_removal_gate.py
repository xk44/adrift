"""CJPersonRemoverAuto: the H3 Relay Person Remover with a per-window quality gate.

The upstream remover (H3RelayPersonRemover) samples each 22-frame window once. Its AddGuide
anchors the green-masked source window as a keyframe clip, and on real footage the remover LoRA
fails to override that on roughly a third to a half of windows, at random per seed:
  * green copy - the window comes back with the green fill pasted through verbatim;
  * regrowth   - the person is regenerated inside the mask instead of the background.
Upstream answers this with manual per-window rerolls in its browser panel. Adrift needs it
unattended, so this node expands the same per-window graph but routes every decoded window
through CJRemovalWindowGate, which scores it and, on a failure, expands a resample of that
window with a new seed (same conditioning, latent and history) before the next window starts.
Later windows take their boundary/history frames from the accepted window, so one bad window
no longer poisons the rest of the clip.

Scores (fractions of the green-mask area, worst frame of the window):
  green  - output pixels inside the mask that are still the green fill colour;
  haze   - mask-interior pixels with a translucent green cast (excess green above anything the
           source scene itself has); catches half-blended fill flashes the green test misses;
  person - SAM3 "person" detections inside the mask, on 4 sampled frames (only when sam_model +
           person_cond are wired; the remover graph already loads SAM3 for tracking);
  part   - SAM3 detections for part_cond (Adrift wires "hand") inside the mask, on every frame.
The person score cannot catch limb remnants: SAM3 also flags empty car seats as a "person" at
0.26-0.33 of the mask, the same as a leftover forearm. "hand" ignores seats (0.000 on every
clean frame) yet fires at 0.15-0.19 on a regrown forearm and on a forearm-shaped ghost of the
mask left on a door, so it runs on every frame (ghosts last 2 frames; ~0.05 s per frame).
After max_attempts the lowest-scoring attempt is kept and the log says the window failed. If
that attempt still has green or hazy frames, plate_fill patches them: each green frame's mask area is
filled from the nearest clean output frame of the same window (frame 0 is always the clean
anchor or carried history), warped by a homography fitted on the unmasked source pixels. Large,
fast-moving subjects (e.g. a raised arm across most of the mask) defeat the LoRA on every seed,
and a parallax-limited plate beats a green silhouette. Needs OpenCV; without it the gate keeps
the best attempt as before.

Prompt: the remover reconstructs far more reliably when the prompt names the background to
rebuild ("...reconstruct the background: the empty cab interior of a white pickup truck...").
The optional `background` input (in Adrift, a TextGenerate caption of the clean first frame)
is spliced in by compose_prompt.

Default limits come from a real-footage grid (2026-10-25): visually clean windows still score
green 0.04-0.08 (codec/edge pixels near the fill colour) and SAM3 flags 0.15-0.17 of the mask
on empty seats, so green 0.1 / person 0.4 separate clean from failed windows; true failures
score ~0.99 green or ~0.94 person. Haze 0.008 / part 0.05 come from the same clip's full runs:
clean frames <= 0.005 on both; haze flashes 0.055-0.14; small solid green-fill blobs left in an
otherwise clean frame 0.010-0.028 (they passed the old 0.03); limb remnants and ghosts 0.15-0.19.

Uses the H3 Relay node classes by name, so h3-relay must be installed. All comfy imports are
lazy so the pure scoring helpers import (and unit-test) without ComfyUI.
"""
import logging
import sys

import torch
import torch.nn.functional as F

_log = logging.getLogger("cj_h3_tools.removal_gate")

# Accepted-attempt bookkeeping across the gate's own expansions: key -> (score, frames, audio).
_BEST = {}
_RESEED = 1_000_003  # added per retry so attempt seeds never collide with neighbouring windows


def green_fill_mask(masked_window):
    """The H3RelayGreenMask fill is exactly (0, 1, 0); tolerate codec-free float noise only."""
    m = masked_window[..., :3]
    return (m[..., 1] > 0.98) & (m[..., 0] < 0.02) & (m[..., 2] < 0.02)


def green_copy_scores(frames, masked_window):
    """Per-frame fraction of the mask area whose output pixels are still green-fill coloured."""
    gm = green_fill_mask(masked_window)
    area = gm.sum(dim=(1, 2)).clamp(min=1)
    f = frames[..., :3]
    greenish = (f[..., 1] > 0.6) & (f[..., 0] < 0.35) & (f[..., 2] < 0.35)
    scores = (greenish & gm).sum(dim=(1, 2)).float() / area
    return torch.where(gm.sum(dim=(1, 2)) > 0, scores, torch.zeros_like(scores))


def overlap_scores(detected, masked_window, indices):
    """Fraction of each sampled frame's mask area covered by a detected-person mask."""
    gm = green_fill_mask(masked_window)
    if detected.dim() == 2:
        detected = detected[None]
    h, w = gm.shape[1:]
    if tuple(detected.shape[1:]) != (h, w):
        detected = F.interpolate(detected[:, None].float(), size=(h, w), mode="bilinear",
                                 align_corners=False)[:, 0]
    out = []
    for j, i in enumerate(indices):
        d = detected[min(j, detected.shape[0] - 1)].to(gm.device) > 0.5
        area = int(gm[i].sum())
        out.append(float((d & gm[i]).sum()) / area if area else 0.0)
    return out


def sample_indices(count, n=4):
    """Spread checks over the window, skipping frame 0 (the carried boundary / clean anchor)."""
    if count <= 1:
        return [0]
    picks = sorted({round(1 + k * (count - 2) / max(1, n - 1)) for k in range(n)})
    return [min(count - 1, p) for p in picks]


GREEN_LIMIT = 0.1
PERSON_LIMIT = 0.4
HAZE_LIMIT = 0.008
PART_LIMIT = 0.05


def _excess_green(x):
    return x[..., 1] - torch.maximum(x[..., 0], x[..., 2])


def haze_scores(frames, masked_window, erode=7, floor=0.2, margin=0.12):
    """Per-frame fraction of the eroded mask interior with a translucent green cast.

    The cast threshold adapts to the scene: max(floor, 99.5th percentile of the source's own
    excess green outside the mask + margin), so foliage or green walls never count."""
    gm = green_fill_mask(masked_window)
    k = 2 * erode + 1
    interior = 1 - F.max_pool2d((~gm).float()[:, None], k, stride=1, padding=erode)[:, 0]
    interior = interior > 0.5
    outside = _excess_green(masked_window[..., :3])[~gm].flatten().float()
    thr = floor
    if outside.numel():
        outside = outside[:: max(1, outside.numel() // 1_000_000)]
        thr = max(floor, float(torch.quantile(outside, 0.995)) + margin)
    cast = _excess_green(frames[..., :3]) > thr
    area = interior.sum(dim=(1, 2))
    scores = (cast & interior).sum(dim=(1, 2)).float() / area.clamp(min=1)
    return torch.where(area > 0, scores, torch.zeros_like(scores))


def compose_prompt(prompt, background):
    """Splice a background description into the remover prompt (unchanged when empty)."""
    bg = " ".join(str(background or "").split()).strip(" .'\"")[:300]
    if not bg:
        return prompt
    if "{background}" in prompt:
        return prompt.replace("{background}", bg)
    marker = "reconstruct the background."
    if marker in prompt:
        return prompt.replace(marker, f"reconstruct the background: {bg}.", 1)
    return f"{prompt.rstrip()} Background to reconstruct: {bg}."


def plate_fill(frames, masked_window, green_limit, feather=3.0, haze_limit=HAZE_LIMIT):
    """Fill still-green (or green-hazed) frames from the nearest clean frame, homography-warped.

    frames / masked_window: (T, H, W, 3) floats in [0, 1]. Returns (frames, filled_count), or
    None when OpenCV is unavailable."""
    try:
        import cv2
        import numpy as np
    except ImportError:
        return None
    scores = green_copy_scores(frames.cpu(), masked_window.cpu())
    hazes = haze_scores(frames.cpu(), masked_window.cpu())
    bad_at = [float(scores[i]) > green_limit or float(hazes[i]) > haze_limit for i in range(len(frames))]
    bad = [i for i in range(len(frames)) if bad_at[i]]
    clean = [j for j in range(len(frames)) if not bad_at[j]]
    if not bad or not clean:
        return frames, 0
    out = frames.detach().cpu().float().clone()
    src = (masked_window.detach().cpu().float().clamp(0, 1).numpy() * 255).astype(np.uint8)
    gms = green_fill_mask(masked_window.cpu()).numpy().astype(np.uint8)
    orb = cv2.ORB_create(4000)
    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    kernel = np.ones((15, 15), np.uint8)
    feats = {}

    def feat(i):
        if i not in feats:
            keep = (1 - cv2.dilate(gms[i], kernel)) * 255
            feats[i] = orb.detectAndCompute(cv2.cvtColor(src[i], cv2.COLOR_RGB2GRAY), keep)
        return feats[i]

    h, w = gms.shape[1:]
    for i in bad:
        j = min(clean, key=lambda c: abs(c - i))
        (kj, dj), (ki, di) = feat(j), feat(i)
        hom = np.eye(3)
        if dj is not None and di is not None and len(kj) > 20 and len(ki) > 20:
            matches = sorted(bf.match(dj, di), key=lambda m: m.distance)[:800]
            if len(matches) >= 12:
                a = np.float32([kj[m.queryIdx].pt for m in matches])
                b = np.float32([ki[m.trainIdx].pt for m in matches])
                found, _ = cv2.findHomography(a, b, cv2.RANSAC, 3.0)
                if found is not None:
                    hom = found
        plate = cv2.warpPerspective(out[j].numpy(), hom, (w, h), borderMode=cv2.BORDER_REPLICATE)
        # Fully opaque over the mask (plus a 2 px guard); the feather fades only outside it. A blur
        # centred on the mask edge would leave ~25% of the green fill showing as a contour.
        grow = 2 + int(np.ceil(2 * feather))
        core = cv2.dilate(gms[i], np.ones((5, 5), np.uint8)).astype(np.float32)
        soft = cv2.GaussianBlur(cv2.dilate(gms[i], np.ones((2 * grow + 1,) * 2, np.uint8)).astype(np.float32),
                                (0, 0), feather)
        alpha = np.maximum(core, soft)[..., None]
        out[i] = torch.from_numpy(plate * alpha + out[i].numpy() * (1 - alpha))
    return out.to(frames.dtype), len(bad)


def judge(green, person, green_limit, person_limit, haze=0.0, haze_limit=HAZE_LIMIT,
          part=0.0, part_limit=PART_LIMIT):
    """(passed, score). score orders attempts when every attempt fails; lower is better."""
    pairs = ((green, green_limit), (person, person_limit), (haze, haze_limit), (part, part_limit))
    score = max(v / max(lim, 1e-6) for v, lim in pairs)
    return all(v <= lim for v, lim in pairs), score


def repairable(green_v, haze_v, green_limit, haze_limit=HAZE_LIMIT, max_patch=0.5):
    """Some, but at most max_patch of the frames are green/hazy: enough clean frames to plate from."""
    bad = [float(g) > green_limit or float(h) > haze_limit for g, h in zip(green_v, haze_v)]
    return len(bad) > 0 and 0 < sum(bad) <= max_patch * len(bad) and _has_cv2()


def attempt_rank(green_v, haze_v, person, part, green_limit, person_limit, haze_limit=HAZE_LIMIT,
                 part_limit=PART_LIMIT, can_patch=True, max_patch=0.5):
    """Sort key for failed attempts; lower is better.

    plate_fill can repair green/hazy frames when the window keeps enough clean frames to copy
    from, but nothing repairs a regrown limb or person. So repairable green/haze only breaks
    ties: a hazy attempt with no remnant beats a clean-looking attempt with a forearm in it."""
    bad = [float(g) > green_limit or float(h) > haze_limit for g, h in zip(green_v, haze_v)]
    soft = max([0.0] + [float(g) / max(green_limit, 1e-6) for g in green_v]
               + [float(h) / max(haze_limit, 1e-6) for h in haze_v])
    hard = max(person / max(person_limit, 1e-6), part / max(part_limit, 1e-6))
    patchable = can_patch and len(bad) > 0 and sum(bad) <= max_patch * len(bad)
    return (hard if patchable else max(hard, soft), soft)


def _relay_planning():
    import nodes
    cls = nodes.NODE_CLASS_MAPPINGS.get("H3RelayPersonRemover")
    if cls is None:
        raise RuntimeError("CJPersonRemoverAuto needs the H3 Relay custom node (H3RelayPersonRemover)")
    mod = sys.modules[cls.__module__]
    return mod.validate_window_size, mod.window_starts


def _person_scores(frames, masked_window, sam_model, person_cond, idx=None, chunk=24):
    from comfy_extras.nodes_sam3 import SAM3_Detect
    idx = sample_indices(len(frames)) if idx is None else idx
    scores = []
    for c in range(0, len(idx), chunk):
        part = idx[c:c + chunk]
        out = SAM3_Detect.execute(model=sam_model, image=frames[part], conditioning=person_cond,
                                  threshold=0.4, refine_iterations=0, individual_masks=False)
        masks = out.result[0] if hasattr(out, "result") else out[0]
        scores += overlap_scores(masks.cpu(), masked_window.cpu(), part)
    return scores


def _has_cv2():
    try:
        import cv2  # noqa: F401
        return True
    except ImportError:
        return False


def every_frame(count):
    """Every frame but 0 (the carried boundary / clean anchor)."""
    return list(range(1, count)) if count > 1 else [0]


def _extra(reseed_step, plate_fallback, haze_limit, sam_model, person_cond, part_cond, part_limit):
    """Optional gate inputs, forwarded unchanged to every attempt."""
    extra = {"reseed_step": reseed_step, "plate_fallback": plate_fallback, "haze_limit": haze_limit}
    if sam_model is not None:
        extra["sam_model"] = sam_model
        if person_cond is not None:
            extra["person_cond"] = person_cond
        if part_cond is not None:
            extra.update(part_cond=part_cond, part_limit=part_limit)
    return extra


class CJRemovalWindowGate:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "frames": ("IMAGE",), "audio": ("AUDIO",), "masked_window": ("IMAGE",),
            "guider": ("GUIDER",), "sampler": ("SAMPLER",), "sigmas": ("SIGMAS",), "latent": ("LATENT",),
            "video_vae": ("VAE",), "audio_vae": ("VAE",),
            "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
            "attempt": ("INT", {"default": 1, "min": 1, "max": 32}),
            "max_attempts": ("INT", {"default": 4, "min": 1, "max": 32}),
            "green_limit": ("FLOAT", {"default": GREEN_LIMIT, "min": 0.0, "max": 1.0, "step": 0.005}),
            "person_limit": ("FLOAT", {"default": PERSON_LIMIT, "min": 0.0, "max": 1.0, "step": 0.01}),
            "window_index": ("INT", {"default": 0, "min": 0}),
            "run_key": ("STRING", {"default": ""}),
        }, "optional": {"sam_model": ("MODEL",), "person_cond": ("CONDITIONING",),
                         "reseed_step": ("INT", {"default": _RESEED, "min": 0, "max": 0xffffffff}),
                         "plate_fallback": ("BOOLEAN", {"default": True}),
                         "part_cond": ("CONDITIONING",),
                         "part_limit": ("FLOAT", {"default": PART_LIMIT, "min": 0.0, "max": 1.0, "step": 0.005}),
                         "haze_limit": ("FLOAT", {"default": HAZE_LIMIT, "min": 0.0, "max": 1.0, "step": 0.001})}}
    RETURN_TYPES = ("IMAGE", "AUDIO")
    FUNCTION = "gate"
    CATEGORY = "Adrift/H3"

    def gate(self, frames, audio, masked_window, guider, sampler, sigmas, latent, video_vae, audio_vae,
             seed, attempt, max_attempts, green_limit, person_limit, window_index, run_key,
             sam_model=None, person_cond=None, reseed_step=_RESEED, plate_fallback=True,
             part_cond=None, part_limit=PART_LIMIT, haze_limit=HAZE_LIMIT):
        key = f"{run_key}:{window_index}"
        if tuple(frames.shape[:3]) != tuple(masked_window.shape[:3]):
            _log.warning("removal gate w%d: frames %s vs mask %s; passing through unchecked",
                         window_index, tuple(frames.shape), tuple(masked_window.shape))
            _BEST.pop(key, None)
            return frames, audio
        green_v = green_copy_scores(frames.cpu(), masked_window.cpu())
        haze_v = haze_scores(frames.cpu(), masked_window.cpu())
        repaired = 0
        nbad = sum(float(g) > green_limit or float(h) > haze_limit for g, h in zip(green_v, haze_v))
        if plate_fallback and repairable(green_v.tolist(), haze_v.tolist(), green_limit, haze_limit):
            # Repair first, then judge: a green-copied frame also reads as a "person"/"hand" to SAM3
            # (the fill keeps the subject's silhouette), so scoring before the fill throws away
            # attempts that are clean everywhere else.
            filled = plate_fill(frames, masked_window, green_limit, haze_limit=haze_limit)
            if filled is not None and filled[1]:
                frames, repaired = filled[0].to(frames.device), filled[1]
                green_v = green_copy_scores(frames.cpu(), masked_window.cpu())
                haze_v = haze_scores(frames.cpu(), masked_window.cpu())
        green, haze = float(green_v.max()), float(haze_v.max())
        person = part = 0.0
        if sam_model is not None and person_cond is not None:
            try:
                person = max(_person_scores(frames, masked_window, sam_model, person_cond))
            except Exception:
                _log.exception("removal gate w%d: SAM3 person check failed; green check only", window_index)
        if sam_model is not None and part_cond is not None:
            try:
                part = max(_person_scores(frames, masked_window, sam_model, part_cond,
                                          idx=every_frame(len(frames))))
            except Exception:
                _log.exception("removal gate w%d: SAM3 part check failed", window_index)
        passed, _ = judge(green, person, green_limit, person_limit, haze, haze_limit, part, part_limit)
        score = attempt_rank(green_v.tolist(), haze_v.tolist(), person, part, green_limit, person_limit,
                             haze_limit, part_limit, can_patch=plate_fallback and _has_cv2())
        _log.info("removal gate w%d attempt %d/%d seed %d: %d/%d frames green/hazy, %sgreen %.3f haze %.3f "
                  "person %.3f part %.3f -> %s", window_index, attempt, max_attempts, seed, nbad, len(green_v),
                  f"plate-filled {repaired}, then " if repaired else "", green, haze, person, part,
                  "ok" if passed else "retry")
        best = _BEST.get(key)
        if best is None or score < best[0]:
            best = (score, frames, audio)
        if passed:
            _BEST.pop(key, None)
            return frames, audio
        if attempt >= max_attempts:
            _BEST.pop(key, None)
            _log.warning("removal gate w%d: no clean attempt in %d; keeping best (unrepairable %.2f, "
                         "green/haze %.2f)", window_index, max_attempts, best[0][0], best[0][1])
            frames = best[1]
            if plate_fallback:
                filled = plate_fill(frames, masked_window, green_limit, haze_limit=haze_limit)
                if filled is None:
                    _log.warning("removal gate w%d: OpenCV missing; no plate fallback", window_index)
                elif filled[1]:
                    frames = filled[0]
                    _log.warning("removal gate w%d: plate-filled %d green/hazy frames from clean neighbours "
                                 "(green now %.3f, haze %.3f)", window_index, filled[1],
                                 float(green_copy_scores(frames, masked_window.cpu()).max()),
                                 float(haze_scores(frames, masked_window.cpu()).max()))
            return frames, best[2]
        _BEST[key] = best
        from comfy_execution.graph_utils import GraphBuilder
        g = GraphBuilder()
        new_seed = (seed + reseed_step) % 0x10000000000000000
        noise = g.node("RandomNoise", noise_seed=new_seed)
        sample = g.node("SamplerCustomAdvanced", noise=noise.out(0), guider=guider, sampler=sampler,
                        sigmas=sigmas, latent_image=latent)
        sep = g.node("LTXVSeparateAVLatent", av_latent=sample.out(0))
        video = g.node("VAEDecode", samples=sep.out(0), vae=video_vae)
        aud = g.node("VAEDecodeAudio", samples=sep.out(1), vae=audio_vae)
        extra = _extra(reseed_step, plate_fallback, haze_limit, sam_model, person_cond, part_cond, part_limit)
        nxt = g.node("CJRemovalWindowGate", frames=video.out(0), audio=aud.out(0),
                     masked_window=masked_window, guider=guider, sampler=sampler, sigmas=sigmas,
                     latent=latent, video_vae=video_vae, audio_vae=audio_vae, seed=new_seed,
                     attempt=attempt + 1, max_attempts=max_attempts, green_limit=green_limit,
                     person_limit=person_limit, window_index=window_index, run_key=run_key, **extra)
        return {"result": (nxt.out(0), nxt.out(1)), "expand": g.finalize()}


class CJPersonRemoverAuto:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",), "clip": ("CLIP",), "video_vae": ("VAE",), "audio_vae": ("VAE",),
            "masked_source": ("IMAGE",), "clean_first_frame": ("IMAGE",),
            "fps": ("FLOAT", {"default": 24.}),
            "prompt": ("STRING", {"multiline": True, "default": "Remove the green-masked person and reconstruct the background. Preserve the rest of the video, including its camera motion and frame timing."}),
            "seed": ("INT", {"default": 904234, "min": 0, "max": 0xffffffffffffffff}),
            "steps": ("INT", {"default": 12, "min": 1, "max": 100}),
        }, "optional": {
            "window_frames": (["22", "39", "56", "73", "90", "107", "124"], {"default": "22"}),
            "max_attempts": ("INT", {"default": 4, "min": 1, "max": 32,
                                     "tooltip": "Samples per window before keeping the best one."}),
            "green_limit": ("FLOAT", {"default": GREEN_LIMIT, "min": 0.0, "max": 1.0, "step": 0.005}),
            "person_limit": ("FLOAT", {"default": PERSON_LIMIT, "min": 0.0, "max": 1.0, "step": 0.01}),
            "sam_model": ("MODEL", {"tooltip": "SAM3 model: enables the regenerated-person check."}),
            "person_cond": ("CONDITIONING", {"tooltip": "CLIPTextEncode('person') with the SAM3 clip."}),
            "reseed_step": ("INT", {"default": _RESEED, "min": 0, "max": 0xffffffff,
                                    "tooltip": "Added to the seed per retry (0 = resample the same seed; diagnostics)."}),
            "background": ("STRING", {"forceInput": True,
                                      "tooltip": "What is behind the person (e.g. a caption of the clean first frame); spliced into the prompt."}),
            "plate_fallback": ("BOOLEAN", {"default": True,
                                           "tooltip": "Patch windows that stay green after max_attempts from a warped clean frame (needs OpenCV)."}),
            "part_cond": ("CONDITIONING", {"tooltip": "CLIPTextEncode('hand') with the SAM3 clip: every-frame check for limb remnants and mask ghosts."}),
            "part_limit": ("FLOAT", {"default": PART_LIMIT, "min": 0.0, "max": 1.0, "step": 0.005}),
            "haze_limit": ("FLOAT", {"default": HAZE_LIMIT, "min": 0.0, "max": 1.0, "step": 0.001}),
        }, "hidden": {"unique_id": "UNIQUE_ID"}}
    RETURN_TYPES = ("IMAGE", "AUDIO")
    RETURN_NAMES = ("clean_frames", "generated_audio")
    FUNCTION = "generate"
    CATEGORY = "Adrift/H3"

    def generate(self, model, clip, video_vae, audio_vae, masked_source, clean_first_frame, fps, prompt,
                 seed, steps, window_frames="22", max_attempts=4, green_limit=GREEN_LIMIT,
                 person_limit=PERSON_LIMIT, sam_model=None, person_cond=None, reseed_step=_RESEED,
                 background="", plate_fallback=True, part_cond=None, part_limit=PART_LIMIT,
                 haze_limit=HAZE_LIMIT, unique_id=None):
        import uuid
        from comfy_execution.graph_utils import GraphBuilder
        validate_window_size, window_starts = _relay_planning()
        window_frames = validate_window_size(window_frames)
        count, height, width, channels = masked_source.shape
        if abs(fps - 24) > 0.001:
            raise ValueError("Person Remover V1 requires a 24 fps source; resample before masking")
        if width % 32 or height % 32 or channels != 3:
            raise ValueError("Use RGB source dimensions divisible by 32")
        if tuple(clean_first_frame.shape[1:]) != (height, width, channels):
            raise ValueError("Clean anchor must match the source resolution and framing")
        starts = window_starts(count, window_frames)
        prompt = compose_prompt(prompt, background)
        _log.info("person remover prompt: %s", prompt)
        run_key = f"{unique_id}:{uuid.uuid4().hex[:8]}"
        g = GraphBuilder()
        sampler = g.node("KSamplerSelect", sampler_name="er_sde")
        sigmas = g.node("BasicScheduler", model=model, scheduler="simple", steps=steps, denoise=1.)
        extra = _extra(reseed_step, plate_fallback, haze_limit, sam_model, person_cond, part_cond, part_limit)
        previous = None
        for index, start in enumerate(starts):
            args = {} if previous is None else {"previous": previous.out(0)}
            window_seed = (int(seed) + index) % 0x10000000000000000
            noise = g.node("RandomNoise", noise_seed=window_seed)
            window = g.node("H3RelayRemovalWindow", source=masked_source, anchor=clean_first_frame,
                            start=start, window_frames=window_frames, **args)
            ref = g.node("MiniMaxH3ReferenceToVideo", prompt=prompt, width=width, height=height,
                         length=window_frames if previous is None else window_frames + 17,
                         ref_image_size="match", clip=clip,
                         **{"ref_images.ref_image_0": window.out(1), "ref_videos.ref_video_0": window.out(0)})
            conditioning, latent = ref.out(0), ref.out(1)
            if previous is not None:
                history = g.node("H3RelaySourceHistory", conditioning=conditioning, latent=latent,
                                 vae=video_vae, audio_vae=audio_vae, previous_frames=window.out(2),
                                 previous_audio=window.out(3))
                conditioning, latent = history.out(0), history.out(1)
            guide = g.node("MiniMaxH3AddGuide", positive=conditioning, latent=latent,
                           vae=video_vae, image=window.out(0), frame_idx=0)
            guider = g.node("CFGGuider", model=model, positive=guide.out(0), negative=guide.out(0), cfg=1.)
            sample = g.node("SamplerCustomAdvanced", noise=noise.out(0), guider=guider.out(0),
                            sampler=sampler.out(0), sigmas=sigmas.out(0), latent_image=latent)
            sep = g.node("LTXVSeparateAVLatent", av_latent=sample.out(0))
            video = g.node("VAEDecode", samples=sep.out(0), vae=video_vae)
            audio = g.node("VAEDecodeAudio", samples=sep.out(1), vae=audio_vae)
            gate = g.node("CJRemovalWindowGate", frames=video.out(0), audio=audio.out(0),
                          masked_window=window.out(0), guider=guider.out(0), sampler=sampler.out(0),
                          sigmas=sigmas.out(0), latent=latent, video_vae=video_vae, audio_vae=audio_vae,
                          seed=window_seed, attempt=1, max_attempts=max_attempts, green_limit=green_limit,
                          person_limit=person_limit, window_index=index, run_key=run_key, **extra)
            previous = g.node("H3RelayRemovalAppend", frames=gate.out(0), audio=gate.out(1),
                              start=start, source_count=count, window_frames=window_frames,
                              window_index=index, **args)
        return {"result": (previous.out(1), previous.out(2)), "expand": g.finalize()}


NODE_CLASS_MAPPINGS = {"CJRemovalWindowGate": CJRemovalWindowGate,
                       "CJPersonRemoverAuto": CJPersonRemoverAuto}
NODE_DISPLAY_NAME_MAPPINGS = {"CJRemovalWindowGate": "Removal Window Gate (Adrift)",
                              "CJPersonRemoverAuto": "Person Remover, auto-retry (Adrift)"}

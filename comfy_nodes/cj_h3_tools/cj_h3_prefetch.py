"""hoist MiniMax H3 reference conditioning out of the h3-relay window loop.

Why: in the windowed graph every loop iteration runs MiniMaxH3ReferenceToVideo, i.e.
VAE-encode refs -> unload all -> load the 25.9 GB Qwen3-VL TE -> encode -> unload all ->
reload the DiT. The TE input depends only on SOURCE frames/audio + prompt + ref image,
never on generated history, so every window's conditioning can be computed up front.

Nodes
- CJH3PrecomputeReferences: one pass over the H3RelayWindowPlan "windows" output.
  Phase 1 (VAE): runs the native node's own reference-block code for every window with a
  probe CLIP (no TE).  Phase 2 (TE): runs the native node per window with vae/audio_vae
  unset, so the TE stays loaded across all windows.  The two halves are merged exactly
  like the native node merges them (conditioning_set_values(cond, {"minimax_refs": ...})).
- CJH3SelectReference: (cache, iteration_index) -> (positive, latent) inside the loop.
- CJH3SourceLatent: drop-in for the loop's VAEEncodeTiled "encode_source". Returns the
  slice of the cached reference-video latent when it is provably identical, else encodes
  exactly like VAEEncodeTiled.
- CJH3SamplingMemory: H3RelaySamplingMemory with selectable unload policy.

All comfy / h3 imports are lazy (inside functions) so importing this module has no side
effects. Window selection and the frame/audio/sampling helpers are implemented here from the
behavioral specs next to them (window contract h3-relay-window-v2).
"""
import logging
import time

import torch

LOG = logging.getLogger("cj_h3_prefetch")
CONTRACT = "h3-relay-window-v2"
CACHE_KIND = "cj-h3-ref-cache-v1"
CACHE_TYPE = "CJ_H3_REF_CACHE"


# -- window frame/audio helpers ----------------------------------------------------------------
#
# Spec (h3-relay-window-v2 timeline: frame indices at 24 fps):
#   pad_frames(frames, length) -> frames with exactly `length` entries along dim 0.
#     * empty input raises ValueError("Cannot pad an empty window");
#     * at least `length` frames: the first `length` (a view, no copy);
#     * fewer: the input followed by its last frame repeated until `length` is reached.
#   slice_audio(audio, start, end, pad=True) -> {"sample_rate": int, "waveform": tensor} or None.
#     * audio None -> None;
#     * start < 0 or end < start raises ValueError("Invalid source audio interval");
#     * frame f maps to sample round(f * rate / 24) (Python round); the slice is
#       waveform[..., round(start) : round(end)] over the last axis (any leading channel dims);
#     * pad=True and the waveform runs out early: zero-fill on the right up to the full span.

_TIMELINE_FPS = 24


def pad_frames(frames, length):
    have = len(frames)
    if have == 0:
        raise ValueError("Cannot pad an empty window")
    missing = length - have
    if missing <= 0:
        return frames[:length]
    tail = frames[have - 1:have].repeat(missing, *([1] * (frames.dim() - 1)))
    return torch.cat([frames, tail], dim=0)


def _frame_to_sample(frame, rate):
    return round(frame * rate / _TIMELINE_FPS)


def slice_audio(audio, start, end, pad=True):
    if audio is None:
        return None
    if start < 0 or start > end:
        raise ValueError("Invalid source audio interval")
    rate = int(audio["sample_rate"])
    lo, hi = _frame_to_sample(start, rate), _frame_to_sample(end, rate)
    span = hi - lo
    clip = audio["waveform"][..., lo:hi]
    short = span - clip.shape[-1]
    if pad and short > 0:
        filler = clip.new_zeros(*clip.shape[:-1], short)
        clip = torch.cat([clip, filler], dim=-1)
    return {"sample_rate": rate, "waveform": clip}


# -- window selection ----------------------------------------------------------------------
#
# Spec: a planned window (contract h3-relay-window-v2) carries index, source_start,
# window_frames, history_frames and source_frames. For one window the loop needs, from the
# source alone:
#   * source_window: frames [start, start+size) clipped to the planned timeline, padded to size;
#   * reference_video: the same span extended back by past = history_frames-1 frames (0 when
#     reference_history is off), padded to size+past;
#   * target_audio / reference_audio: the matching audio spans (padded to the full window);
#   * conditioning_length: size + max(0, history_frames-1), independent of reference_history.
# Checked in order: 24 fps, timeline covered (1 <= source_frames <= len(source),
# 0 <= start < source_frames), RGB with H/W multiples of 32, history not before frame 0.

def window_entry(windows, iteration_index):
    window = windows["windows"][iteration_index] if "windows" in windows else windows
    if window.get("contract") != CONTRACT:
        raise ValueError("Unsupported H3 window contract")
    return window


def _check_source(source, count, start):
    covered = 1 <= count <= len(source) and 0 <= start < count
    if not covered:
        raise ValueError("Source does not cover the planned timeline")
    _, height, width, channels = source.shape
    if channels != 3 or height % 32 != 0 or width % 32 != 0:
        raise ValueError("H3 source must be RGB with dimensions divisible by 32")


def window_reference_inputs(source, window, source_audio=None, reference_history=True, fps=24.):
    """Source-only per-window inputs: source_window, target_audio, reference_video,
    reference_audio, conditioning_length (plus the window geometry)."""
    if abs(fps - _TIMELINE_FPS) > 1e-3:
        raise ValueError("H3 windows require a 24 fps source; resample before masking")
    start = window["source_start"]
    size = window["window_frames"]
    hist = window["history_frames"]
    _check_source(source, window["source_frames"], start)
    lookback = max(hist - 1, 0)
    past = lookback if reference_history else 0
    if past > start:
        raise ValueError("Reference history precedes the source")
    stop = min(start + size, window["source_frames"])
    window_end = start + size
    info = {"index": window["index"], "start": start, "size": size, "hist": hist, "past": past}
    info["source_window"] = pad_frames(source[start:stop], size)
    info["target_audio"] = slice_audio(source_audio, start, window_end)
    info["reference_video"] = pad_frames(source[start - past:stop], size + past)
    info["reference_audio"] = slice_audio(source_audio, start - past, window_end)
    info["conditioning_length"] = size + lookback
    return info


# -- helpers -------------------------------------------------------------------------------

class _RefBlockProbe:
    """Stand-in CLIP: lets the native node build its VAE reference blocks without the TE."""

    def tokenize(self, *args, **kwargs):
        return None

    def encode_from_tokens_scheduled(self, *args, **kwargs):
        return [[torch.zeros(1, 1, 1), {}]]


def _native_inputs(ref_images, reference_video, reference_audio, use_reference_audio):
    images = {k: v for k, v in ref_images.items() if v is not None}
    audios = {"ref_audio_0": reference_audio} if use_reference_audio and reference_audio is not None else None
    return images or None, {"ref_video_0": reference_video}, audios


def _cpu(value):
    if torch.is_tensor(value):
        return value.cpu() if value.device.type != "cpu" else value
    if isinstance(value, dict):
        return {k: _cpu(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_cpu(v) for v in value]
    if isinstance(value, tuple):
        return tuple(_cpu(v) for v in value)
    return value


def _tensor_bytes(value, seen=None):
    seen = set() if seen is None else seen
    if torch.is_tensor(value):
        if getattr(value, "is_nested", False) and hasattr(value, "tensors"):
            return sum(_tensor_bytes(t, seen) for t in value.tensors)
        key = (value.untyped_storage().data_ptr(), value.device.type)
        if key in seen:
            return 0
        seen.add(key)
        return value.untyped_storage().nbytes()
    if isinstance(value, dict):
        return sum(_tensor_bytes(v, seen) for v in value.values())
    if isinstance(value, (list, tuple)):
        return sum(_tensor_bytes(v, seen) for v in value)
    return 0


def _source_reuse(vae, info, ref_block, width, height, allow_uint8_approx=False):
    """Return (latent_slice, reason). latent_slice is not None only when the cached reference
    latent provably equals what VAEEncodeTiled(source_window) produces:
      * native ref-video canvas == source canvas and the native lanczos pass is an exact identity
        on these frames (checked by running the native _resize itself),
      * reference_video[past:] == source_window frame-for-frame,
      * the VAE encodes independent clip_length-frame clips (MiniMaxH3VideoVAE.encode_temporal),
        past is a whole number of clips, so ref clip k+1 == source clip k, and its tiled entry
        point (encode_tiled -> encode) runs the same per-clip math as encode.
    allow_uint8_approx: skip only the lanczos-identity proof. The native ref path floors frames to
    uint8 (comfy.utils.lanczos); float sources decoded from yuv are off that grid, so the reused
    latent then encodes frames that differ by < 1/255 per channel from what encode_source sees.
    """
    from comfy_extras import nodes_minimax_h3 as h3
    model = getattr(vae, "first_stage_model", None)
    if type(model).__name__ != "MiniMaxH3VideoVAE" or not getattr(model, "comfy_has_chunked_io", False):
        return None, "vae is not MiniMaxH3VideoVAE"
    if not getattr(vae, "handles_tiling", False):
        return None, "vae does not own its tiling"
    clip, tokens = model.clip_length, model.tokens_chunk_size
    past, size = info["past"], info["size"]
    ref, src = info["reference_video"], info["source_window"]
    if past % clip or (size+past) % clip != size % clip:
        return None, f"history offset {past} is not a whole number of {clip}-frame VAE clips"
    vh, vw = ref.shape[1], ref.shape[2]
    cw, ch = h3.adapt_canvas(vw, vh)
    if vw * vh < cw * ch:
        cw = max(h3.CANVAS_MULTIPLE, round(vw / h3.CANVAS_MULTIPLE) * h3.CANVAS_MULTIPLE)
        ch = max(h3.CANVAS_MULTIPLE, round(vh / h3.CANVAS_MULTIPLE) * h3.CANVAS_MULTIPLE)
    if (cw, ch) != (vw, vh):
        return None, f"native ref canvas {cw}x{ch} != source {vw}x{vh}"
    # the native node encodes min(len, frame_count) frames trimmed to 17k+5; ours must be all of them
    frame_count = h3.align_frame_count(max(5, info["conditioning_length"]))
    if len(ref) > frame_count or len(ref) % 17 != 5 or len(src) % 17 != 5:
        return None, "reference clip would be trimmed by the native node"
    if not torch.equal(ref[past:], src):
        return None, "reference_video[past:] != source_window"
    mode = "exact"
    for i in range(0, len(ref), clip):  # chunked: native lanczos round trip must be identity
        part = ref[i:i+clip]
        # cheap necessary condition first: lanczos returns uint8/255 values, so off-grid input
        # can never round-trip; skips a full-res PIL pass per window on yuv-decoded sources
        on_grid = torch.equal(torch.floor(part[..., :3] * 255.0 + 0.5) / 255.0, part[..., :3])
        if not on_grid or not torch.equal(h3._resize(part, cw, ch, "disabled"), part[..., :3]):
            if not allow_uint8_approx:
                return None, "native lanczos resize is not an identity on these frames (off uint8 grid)"
            mode = "approx-uint8"
            break
    latent = ref_block["latent"]
    skip = past // clip * tokens
    sliced = latent[:, :, skip:]
    expected = (latent.shape[0], 24, h3.video_latent_t(size), height // 16, width // 16)
    if tuple(sliced.shape) != expected:
        return None, f"sliced latent {tuple(sliced.shape)} != expected {expected}"
    return sliced, f"{mode} (ref latent[:, :, {skip}:])"


# -- nodes ---------------------------------------------------------------------------------

class CJH3PrecomputeReferences:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "windows": ("H3_RELAY_WINDOWS",),
            "source": ("IMAGE",),
            "clip": ("CLIP", {"tooltip": "Raw MiniMax H3 TE (not the H3RelayTextMemory-wrapped one)."}),
            "vae": ("VAE",),
            "audio_vae": ("VAE",),
            "prompt": ("STRING", {"multiline": True}),
            "width": ("INT", {"default": 1344, "min": 32, "max": 16384, "step": 32}),
            "height": ("INT", {"default": 768, "min": 32, "max": 16384, "step": 32}),
            "ref_image_size": (["match", "max"], {"default": "match"}),
            "reference_history": ("BOOLEAN", {"default": True}),
            "use_reference_audio": ("BOOLEAN", {"default": True,
                "tooltip": "Feed each window's source-audio slice as ref_audio_0 (WindowInputs output 6)."}),
            "fps": ("FLOAT", {"default": 24.}),
            "verify_source_reuse": ("BOOLEAN", {"default": True,
                "tooltip": "Prove per window that the ref-video latent slice equals encode_source. Off = always re-encode."}),
            "allow_uint8_approx": ("BOOLEAN", {"default": False,
                "tooltip": "Also reuse when the only difference is the native uint8 floor of off-grid float frames (<1/255). Not bitwise; experimental."}),
            "release_models": ("BOOLEAN", {"default": True,
                "tooltip": "unload_all_models() before and after the TE phase (skipped in HIGH_VRAM)."}),
        }, "optional": {
            "source_audio": ("AUDIO",),
            "ref_image_0": ("IMAGE",), "ref_image_1": ("IMAGE",),
            "ref_image_2": ("IMAGE",), "ref_image_3": ("IMAGE",),
        }}

    RETURN_TYPES = (CACHE_TYPE, "STRING")
    RETURN_NAMES = ("cache", "report")
    FUNCTION = "precompute"
    CATEGORY = "cj/h3"
    DESCRIPTION = "Run MiniMaxH3ReferenceToVideo for every planned window in one pass (one TE load)."

    def precompute(self, windows, source, clip, vae, audio_vae, prompt, width, height,
                   ref_image_size="match", reference_history=True, use_reference_audio=True, fps=24.,
                   verify_source_reuse=True, release_models=True, source_audio=None,
                   allow_uint8_approx=False, **ref_images):
        import comfy.model_management as mm
        import comfy.utils
        import node_helpers
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo as Native

        entries = windows["windows"] if "windows" in windows else [windows]
        ref_images = {k: ref_images.get(k) for k in sorted(ref_images) if k.startswith("ref_image_")}
        pbar = comfy.utils.ProgressBar(2 * len(entries))
        high_vram = mm.vram_state == mm.VRAMState.HIGH_VRAM
        records, lines = [], []
        t_all = time.perf_counter()

        # phase 1: native reference blocks (VAE only, TE untouched)
        for i, window in enumerate(entries):
            window = window_entry({"windows": entries}, i)
            t0 = time.perf_counter()
            info = window_reference_inputs(source, window, source_audio, reference_history, fps)
            imgs, vids, auds = _native_inputs(ref_images, info["reference_video"], info["reference_audio"],
                                              use_reference_audio)
            probe = Native.execute(clip=_RefBlockProbe(), prompt=prompt, width=width, height=height,
                                   length=info["conditioning_length"], ref_image_size=ref_image_size,
                                   vae=vae, audio_vae=audio_vae, ref_images=imgs, ref_videos=vids,
                                   ref_audios=auds)
            blocks = probe[0][0][1].get("minimax_refs", [])
            source_latent, reason = None, "verification disabled"
            if verify_source_reuse:
                video_blocks = [b for b in blocks if b.get("kind") in ("video", "video_audio")]
                if len(video_blocks) == 1:
                    source_latent, reason = _source_reuse(vae, info, video_blocks[0], width, height,
                                                                  allow_uint8_approx)
                else:
                    reason = f"{len(video_blocks)} video reference blocks"
            records.append({"index": window["index"], "length": info["conditioning_length"],
                            "blocks": _cpu(blocks), "source_latent": _cpu(source_latent),
                            "source_reason": reason, "info": {k: info[k] for k in ("start", "size", "hist", "past")}})
            dt = time.perf_counter() - t0
            lines.append(f"w{window['index']}: vae phase {dt:.1f}s; source reuse: {reason}")
            LOG.info("CJ H3 prefetch: window %d VAE refs %.1fs; source reuse: %s", window["index"], dt, reason)
            pbar.update(1)

        if release_models and not high_vram:
            mm.unload_all_models()
            LOG.info("CJ H3 prefetch: released VAEs before the TE phase")
        t_te = time.perf_counter()
        try:
            # phase 2: native text conditioning (no vae -> no reference blocks), TE stays loaded
            for i, record in enumerate(records):
                window = entries[i]
                t0 = time.perf_counter()
                info = window_reference_inputs(source, window, source_audio, reference_history, fps)
                imgs, vids, auds = _native_inputs(ref_images, info["reference_video"], info["reference_audio"],
                                                  use_reference_audio)
                out = Native.execute(clip=clip, prompt=prompt, width=width, height=height,
                                     length=info["conditioning_length"], ref_image_size=ref_image_size,
                                     vae=None, audio_vae=None, ref_images=imgs, ref_videos=vids, ref_audios=auds)
                cond = out[0]
                if record["blocks"]:
                    cond = node_helpers.conditioning_set_values(cond, {"minimax_refs": record["blocks"]})
                record["cond"] = _cpu(cond)
                dt = time.perf_counter() - t0
                lines.append(f"w{window['index']}: te {dt:.1f}s")
                LOG.info("CJ H3 prefetch: window %d TE %.1fs", window["index"], dt)
                pbar.update(1)
        finally:
            if release_models and not high_vram:
                mm.unload_all_models()
                LOG.info("CJ H3 prefetch: released text encoder after the TE phase")

        cache = {"kind": CACHE_KIND, "width": width, "height": height, "windows": records}
        size_mb = _tensor_bytes([r["cond"] for r in records] + [r["source_latent"] for r in records]) / 2**20
        lines.append(f"te phase {time.perf_counter()-t_te:.1f}s; total {time.perf_counter()-t_all:.1f}s; "
                     f"cache ~{size_mb:.0f} MiB CPU")
        report = "\n".join(lines)
        LOG.info("CJ H3 prefetch: %d windows, TE phase %.1fs, total %.1fs, cache ~%.0f MiB",
                 len(records), time.perf_counter()-t_te, time.perf_counter()-t_all, size_mb)
        return (cache, report)


def _cache_record(cache, iteration_index):
    if not isinstance(cache, dict) or cache.get("kind") != CACHE_KIND:
        raise ValueError("Expected an CJ H3 reference cache")
    records = cache["windows"]
    if not 0 <= iteration_index < len(records):
        raise ValueError(f"iteration_index {iteration_index} outside the {len(records)} cached windows")
    record = records[iteration_index]
    if record["index"] != iteration_index:
        raise ValueError("Cached window order does not match the loop index")
    return record


def _copy_cond(cond):
    out = []
    for embedding, meta in cond:
        meta = dict(meta)
        if "minimax_refs" in meta:
            meta["minimax_refs"] = [dict(b) for b in meta["minimax_refs"]]
        out.append([embedding, meta])
    return out


class CJH3SelectReference:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"cache": (CACHE_TYPE,),
                             "iteration_index": ("INT", {"default": 0, "min": 0})}}

    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "latent")
    FUNCTION = "select"
    CATEGORY = "cj/h3"
    DESCRIPTION = "Per-loop-iteration outputs of MiniMaxH3ReferenceToVideo from the precomputed cache."

    def select(self, cache, iteration_index=0):
        from comfy_extras.nodes_minimax_h3 import _empty_av_latent
        record = _cache_record(cache, iteration_index)
        latent, _ = _empty_av_latent(cache["width"], cache["height"], record["length"])
        return (_copy_cond(record["cond"]), latent)


class CJH3SourceLatent:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "cache": (CACHE_TYPE,),
            "iteration_index": ("INT", {"default": 0, "min": 0}),
            "pixels": ("IMAGE",), "vae": ("VAE",),
            "tile_size": ("INT", {"default": 1024, "min": 64, "max": 4096, "step": 64}),
            "overlap": ("INT", {"default": 64, "min": 0, "max": 4096, "step": 32}),
            "temporal_size": ("INT", {"default": 32, "min": 8, "max": 4096, "step": 4}),
            "temporal_overlap": ("INT", {"default": 8, "min": 4, "max": 4096, "step": 4}),
            "reuse": ("BOOLEAN", {"default": True}),
        }}

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "encode"
    CATEGORY = "cj/h3"
    DESCRIPTION = "VAEEncodeTiled(source_window), served from the cached ref-video latent when provably identical."

    def encode(self, cache, iteration_index, pixels, vae, tile_size, overlap, temporal_size=32,
               temporal_overlap=8, reuse=True):
        record = _cache_record(cache, iteration_index)
        latent = record.get("source_latent")
        if reuse and latent is not None and pixels.shape[0] % 17 == 5 \
                and latent.shape[2] == (pixels.shape[0] - 5) // 17 * 5 + 2 \
                and latent.shape[3] * 16 == pixels.shape[1] and latent.shape[4] * 16 == pixels.shape[2]:
            LOG.info("CJ H3 prefetch: window %d source latent reused (%s)", iteration_index, record["source_reason"])
            return ({"samples": latent.clone()},)
        LOG.info("CJ H3 prefetch: window %d source latent encoded (%s)", iteration_index,
                 record.get("source_reason") if reuse else "reuse off")
        t = vae.encode_tiled(pixels, tile_x=tile_size, tile_y=tile_size, overlap=overlap,
                             tile_t=temporal_size, overlap_t=temporal_overlap)
        return ({"samples": t},)


def sampling_workspace(model, activation_memory_gib, management, wrapper_type,
                       unload_before=True, unload_after=True):
    """Clone `model` with an OUTER_SAMPLE-style wrapper that (a) reports at least
    activation_memory_gib of required memory while sampling and (b) optionally frees all loaded
    models before cloning and after sampling. Unloads are skipped in HIGH_VRAM mode."""
    may_unload = management.vram_state != management.VRAMState.HIGH_VRAM
    floor_bytes = activation_memory_gib * 2**30
    if may_unload and unload_before:
        management.unload_all_models()
    workspace = model.clone()
    estimate = model.get_model_object("memory_required")

    def at_least_floor(input_shape, cond_shapes=None):
        return max(estimate(input_shape, cond_shapes or {}), floor_bytes)

    def wrapper(executor, *args, **kwargs):
        inner = workspace.model
        saved = inner.memory_required
        inner.memory_required = at_least_floor
        try:
            result = executor(*args, **kwargs)
        finally:
            inner.memory_required = saved
            if may_unload and unload_after:
                management.unload_all_models()
                LOG.info("CJ H3 sampling: released models after sampling")
        return result

    workspace.add_wrapper(wrapper_type, wrapper)
    return workspace


class CJH3SamplingMemory:
    POLICIES = {"both (h3-relay default)": (True, True), "before only": (True, False),
                "after only": (False, True), "none (keep DiT resident)": (False, False)}

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "latent": ("LATENT",), "conditioning": ("CONDITIONING",),
                "activation_memory_gib": ("FLOAT", {"default": 17., "min": 0., "max": 128., "step": .5}),
                "unload_policy": (list(cls.POLICIES), {"default": "none (keep DiT resident)"})}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "apply"
    CATEGORY = "cj/h3"
    DESCRIPTION = "H3RelaySamplingMemory with a selectable unload_all_models() policy."

    def apply(self, model, latent, conditioning, activation_memory_gib=17., unload_policy="none (keep DiT resident)"):
        import comfy.model_management as management
        from comfy.patcher_extension import WrappersMP
        before, after = self.POLICIES[unload_policy]
        return (sampling_workspace(model, activation_memory_gib, management, WrappersMP.OUTER_SAMPLE,
                                   before, after),)


NODE_CLASS_MAPPINGS = {
    "CJH3PrecomputeReferences": CJH3PrecomputeReferences,
    "CJH3SelectReference": CJH3SelectReference,
    "CJH3SourceLatent": CJH3SourceLatent,
    "CJH3SamplingMemory": CJH3SamplingMemory,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "CJH3PrecomputeReferences": "H3 Prefetch · Precompute References (all windows)",
    "CJH3SelectReference": "H3 Prefetch · Select Reference",
    "CJH3SourceLatent": "H3 Prefetch · Source Latent (reuse ref encode)",
    "CJH3SamplingMemory": "H3 Prefetch · Sampling Memory (unload policy)",
}

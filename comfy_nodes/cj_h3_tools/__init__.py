"""Adrift H3 tools: the local nodes the H3 masked character-swap / relay pipeline depends on.

Each module registers independently: one failing import (missing cv2/av, older ComfyUI without
comfy_api.torch_helpers) logs and disables only that module's nodes, never ComfyUI startup.
"""
import importlib
import logging

_log = logging.getLogger("cj_h3_tools")

_MODULES = (
    "cj_pasteback",            # CJPasteBackSave: masked paste-back onto the source at source res, audio copied
    "cj_image_pasteback",      # CJImagePasteBack: image edit pasted onto the original at full res, masked
    "cj_window_preview",       # CJWindowPreview: per-relay-window mp4 preview, frames pass through
    "cj_subject_face_polish",  # CJSubjectFaceSeed / CJMaskedFaceClamp: per-subject face polish bound to its mask
    "cj_h3_prefetch",          # hoists H3 reference/TE conditioning out of the relay window loop
    "cj_chunked_attention",    # CJChunkedAttention: exact query-chunked SDPA (MPS memory limit)
    "cj_compile_blocks",       # CJTorchCompileBlocks: torch.compile only the diffusion transformer blocks
    "cj_video_matte",          # CJMaskTemporal / CJVideoBgComposite: stable video masks, matte over new background
    "cj_removal_gate",         # CJPersonRemoverAuto / CJRemovalWindowGate: H3 person remover with per-window auto-retry
    "cj_mask_blob",            # CJMaskBlob: convex-hull / temporal-union mask so removal holes carry no limb shape
    "cj_grid_video",           # CJGridVideo: beat-synced grid music video (plan JSON -> numpy render + ffmpeg mux)
    "cj_video_palette",        # CJVideoPalette: one-fit OKLab LUT regrade of a clip to a palette / reference still (.cube export)
    "cj_exact",                # CJExactPrepare / CJExactPasteSave: every source frame 1:1, composite in native YUV
    "cj_subject_frame",        # CJSampleFrames / CJFindSubjectFrame: pick the frame to seed a tracker on
    "cj_repeat_audio",         # CJRepeatAudio: same clip several times over, so VibeVoice-ASR can tell speakers apart
    "cj_followcam",            # CJFollowCam*: smoothed subject crop at model res + feathered paste-back into a hi-res plate
)

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

for _name in _MODULES:
    try:
        _mod = importlib.import_module(f".{_name}", __name__)
    except Exception:
        _log.exception("cj_h3_tools: %s failed to import; its nodes are disabled", _name)
        continue
    NODE_CLASS_MAPPINGS.update(getattr(_mod, "NODE_CLASS_MAPPINGS", {}))
    NODE_DISPLAY_NAME_MAPPINGS.update(getattr(_mod, "NODE_DISPLAY_NAME_MAPPINGS", {}))

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

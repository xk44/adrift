"""cj_stems: CJAudioStems, local Hybrid Demucs stem separation for the Adrift Music video tool (see README.md)."""
import logging

_log = logging.getLogger("cj_stems")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    from .cj_audio_stems import NODE_CLASS_MAPPINGS as _N, NODE_DISPLAY_NAME_MAPPINGS as _D

    NODE_CLASS_MAPPINGS.update(_N)
    NODE_DISPLAY_NAME_MAPPINGS.update(_D)
except Exception:
    _log.exception("cj_stems failed to import; CJAudioStems is disabled")

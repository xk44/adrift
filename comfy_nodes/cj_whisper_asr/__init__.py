"""cj_whisper_asr: CJWhisperASR, local Whisper speech-to-text for the Adrift dub pipeline (see README.md)."""
import logging

_log = logging.getLogger("cj_whisper_asr")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    from .cj_whisper_asr import NODE_CLASS_MAPPINGS as _N, NODE_DISPLAY_NAME_MAPPINGS as _D

    NODE_CLASS_MAPPINGS.update(_N)
    NODE_DISPLAY_NAME_MAPPINGS.update(_D)
except Exception:
    _log.exception("cj_whisper_asr failed to import; CJWhisperASR is disabled")

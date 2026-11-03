"""cj_sa3_audio: Stable Audio 3 inpaint/continuation conditioning + audio pasteback for Adrift (see README.md)."""
import logging

_log = logging.getLogger("cj_sa3_audio")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    from .sa3_nodes import NODE_CLASS_MAPPINGS as _N, NODE_DISPLAY_NAME_MAPPINGS as _D

    NODE_CLASS_MAPPINGS.update(_N)
    NODE_DISPLAY_NAME_MAPPINGS.update(_D)
except Exception:
    _log.exception("cj_sa3_audio failed to import; SA3 audio nodes are disabled")

try:
    from .train_node import NODE_CLASS_MAPPINGS as _TN, NODE_DISPLAY_NAME_MAPPINGS as _TD

    NODE_CLASS_MAPPINGS.update(_TN)
    NODE_DISPLAY_NAME_MAPPINGS.update(_TD)
except Exception:
    _log.exception("cj_sa3_audio train node failed to import; audio LoRA training is disabled")

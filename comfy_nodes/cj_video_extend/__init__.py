"""Adrift video-extend helpers (Extend video, packs/wan22/vace_extend.json).

CJColorMatchToReference: LAB mean/std colour match of generated frames to reference frames.
CJRetimeFrames: resample a frame batch from one fps to another (nearest duplicate/drop or linear blend).

torch only, no extra dependencies. A failed import logs and disables these nodes, never ComfyUI startup.
"""
import logging

_log = logging.getLogger("cj_video_extend")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    from . import cj_extend_nodes as _mod

    NODE_CLASS_MAPPINGS.update(_mod.NODE_CLASS_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(_mod.NODE_DISPLAY_NAME_MAPPINGS)
except Exception:
    _log.exception("cj_video_extend: cj_extend_nodes failed to import; its nodes are disabled")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

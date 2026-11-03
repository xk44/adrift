"""Adrift image tools: Vector (raster -> SVG) and Breakdown (per-instance RGBA cutouts + contact sheet).

Each module registers independently: one failing import logs and disables only that module's nodes,
never ComfyUI startup. Needs only numpy, opencv-python and Pillow (ComfyUI deps); vtracer is optional.
"""
import importlib
import logging

_log = logging.getLogger("cj_image_tools")

_MODULES = (
    "cj_vectorize",  # CJVectorize: IMAGE -> SVG file + rasterized preview (OpenCV tracer, optional vtracer)
    "cj_cutouts",    # CJCutouts: IMAGE + per-part MASK batches -> RGBA cutout PNGs + labelled contact sheet
    "cj_lens_blur",  # CJRefocus / CJRackFocus: depth-aware layered lens blur (torch only)
    "cj_layer_preview",  # CJLayerPreview: see-through parts -> depth composite + labelled parts sheet
)

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

for _name in _MODULES:
    try:
        _mod = importlib.import_module(f".{_name}", __name__)
    except Exception:
        _log.exception("cj_image_tools: %s failed to import; its nodes are disabled", _name)
        continue
    NODE_CLASS_MAPPINGS.update(getattr(_mod, "NODE_CLASS_MAPPINGS", {}))
    NODE_DISPLAY_NAME_MAPPINGS.update(getattr(_mod, "NODE_DISPLAY_NAME_MAPPINGS", {}))

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

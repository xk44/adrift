"""
Adrift overlay for ComfyUI
==========================
A ComfyUI frontend extension (web/adrift_overlay.js) that shows the Adrift
app over the node graph: a corner button, or Ctrl+Shift+J, swaps between
the graph and Adrift (full window or a docked panel). The app itself is
served by the Adrift server; this pack only ships the bridge script.

No nodes. ComfyUI serves web/ under /extensions/<this folder name>/.
web/adrift_config.json (optional, written by Adrift's "Add Adrift to
ComfyUI" step) tells the bridge where Adrift runs.
"""

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

WEB_DIRECTORY = "web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

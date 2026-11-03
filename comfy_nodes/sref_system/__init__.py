"""Adrift LoRA shortcode nodes for ComfyUI."""

from .nodes.lora_shortcodes import (
    LoRAShortcodeRegistry,
    LoRAShortcodeLookup,
    LoRAShortcodeRandom,
    LoRATriggerInserter,
)

# Note: LoRARegisterShortcode is available in nodes but not exposed as a separate ComfyUI node

NODE_CLASS_MAPPINGS = {
    # LoRA Shortcodes
    "LoRAShortcodeRegistry": LoRAShortcodeRegistry,
    "LoRAShortcodeLookup": LoRAShortcodeLookup,
    "LoRAShortcodeRandom": LoRAShortcodeRandom,
    "LoRATriggerInserter": LoRATriggerInserter,
}

# Display names for ComfyUI UI
NODE_DISPLAY_NAME_MAPPINGS = {
    # LoRA Shortcodes
    "LoRAShortcodeRegistry": "LoRA Shortcode Registry",
    "LoRAShortcodeLookup": "LoRA Shortcode Lookup",
    "LoRAShortcodeRandom": "LoRA Shortcode Random",
    "LoRATriggerInserter": "LoRA Trigger Inserter",
}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]

# The in-ComfyUI Adrift overlay used to ship from this pack's web/ folder; it
# is its own pack now (comfy_nodes/adrift_overlay). No WEB_DIRECTORY here, so
# the overlay can't register twice when both packs are installed.

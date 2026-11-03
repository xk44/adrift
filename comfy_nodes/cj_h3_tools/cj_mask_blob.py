"""CJMaskBlob: turn a tracked subject mask into a shapeless blob before green-filling it.

The H3 person remover regrows whatever the hole looks like: an arm-shaped hole on a car window
sill comes back as a forearm on most seeds, even with a clean anchor frame and the background
described in the prompt. A convex hull per region (optionally unioned over neighbouring frames
and grown) removes the limb silhouette, so the model has no shape to complete. It costs some
extra reconstructed background around the subject.
"""
import torch
import torch.nn.functional as F


def hull_mask(mask, min_area=16):
    """(T, H, W) float mask -> same shape, each connected region replaced by its convex hull."""
    import cv2
    import numpy as np
    m = (mask.detach().cpu().float().numpy() > 0.5).astype(np.uint8)
    out = np.zeros_like(m)
    for t in range(m.shape[0]):
        contours, _ = cv2.findContours(m[t], cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        hulls = [cv2.convexHull(c) for c in contours if cv2.contourArea(c) >= min_area]
        if hulls:
            cv2.fillPoly(out[t], hulls, 1)
        out[t] |= m[t]                       # tiny regions below min_area stay as they were
    return torch.from_numpy(out.astype(np.float32)).to(mask.device)


def temporal_union(mask, radius):
    """Max over frames t-radius..t+radius: the hole stops flickering with the subject's pose."""
    if radius <= 0 or mask.shape[0] < 2:
        return mask
    x = mask.float().permute(1, 2, 0).reshape(1, -1, mask.shape[0])
    x = F.max_pool1d(x, 2 * radius + 1, stride=1, padding=radius)
    return x.reshape(mask.shape[1], mask.shape[2], -1).permute(2, 0, 1).contiguous()


def grow(mask, pixels):
    if pixels <= 0:
        return mask
    k = 2 * pixels + 1
    return F.max_pool2d(mask.float()[:, None], k, stride=1, padding=pixels)[:, 0]


def blob(mask, hull=True, temporal_radius=0, grow_pixels=0):
    if mask.dim() == 2:
        mask = mask[None]
    out = hull_mask(mask) if hull else (mask > 0.5).float()
    out = temporal_union(out, temporal_radius)
    return grow(out, grow_pixels).clamp(0, 1)


class CJMaskBlob:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "mask": ("MASK",),
            "hull": ("BOOLEAN", {"default": True, "tooltip": "Replace each region with its convex hull (drops limb shapes)."}),
            "temporal_radius": ("INT", {"default": 2, "min": 0, "max": 24,
                                        "tooltip": "Union the mask over +-N frames so the hole does not follow every gesture."}),
            "grow_pixels": ("INT", {"default": 0, "min": 0, "max": 128}),
        }}
    RETURN_TYPES = ("MASK",)
    FUNCTION = "apply"
    CATEGORY = "Adrift/H3"

    def apply(self, mask, hull=True, temporal_radius=2, grow_pixels=0):
        return (blob(mask, hull, temporal_radius, grow_pixels),)


NODE_CLASS_MAPPINGS = {"CJMaskBlob": CJMaskBlob}
NODE_DISPLAY_NAME_MAPPINGS = {"CJMaskBlob": "Mask Blob (hull / temporal union)"}

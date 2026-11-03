"""Per-subject face polish helpers for H3 relay swaps.

Face polish (H3FaceTrackCrop -> VOSR2 -> H3FaceStitch) picks faces by detector rank and has no
notion of the generation mask. These two nodes bind it to one subject:

  CJSubjectFaceSeed   MASK -> X, Y, frame_index  (feed H3FaceTrackCrop select=closest_to_xy)
  CJMaskedFaceClamp   keep the polish only inside that subject's mask; report how much of the
                       change the clamp threw away (high = tracker drifted onto someone else)

Two subjects = two chained passes, each with its own seed + clamp, so faces never mix.
"""
import torch
import torch.nn.functional as F


def _head_point(m: torch.Tensor, head_frac: float):
    ys, xs = torch.nonzero(m > 0.5, as_tuple=True)
    y0, y1 = int(ys.min()), int(ys.max())
    head = ys <= y0 + head_frac * (y1 - y0)
    hx = xs[head].float()
    cx = float((hx.min() + hx.max()) / 2)
    cy = y0 + head_frac * (y1 - y0) * 0.55
    return cx, cy


class CJSubjectFaceSeed:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "mask": ("MASK",),
            "images": ("IMAGE", {"tooltip": "Frames the polish runs on; only their size is read, so the "
                                            "point is scaled into their pixel space."}),
            "min_area_frac": ("FLOAT", {"default": 0.002, "min": 0.0, "max": 0.5, "step": 0.001,
                                        "tooltip": "Frames whose mask covers less than this fraction of the "
                                                   "frame are never used as the seed frame."}),
            "seed_frame": (["largest_mask", "first_visible"], {
                "default": "largest_mask",
                "tooltip": "largest_mask: seed where the subject's mask is biggest (fully in shot), so the "
                           "nearest face there is theirs. first_visible: first frame over min_area_frac - "
                           "can land on a sliver at the frame edge next to someone else's face."}),
            "head_frac": ("FLOAT", {"default": 0.30, "min": 0.05, "max": 1.0, "step": 0.01,
                                    "tooltip": "Top fraction of the mask's height treated as the head."}),
        }}

    RETURN_TYPES = ("INT", "INT", "INT", "STRING")
    RETURN_NAMES = ("X", "Y", "frame_index", "report")
    FUNCTION = "run"
    CATEGORY = "cj/h3"

    def run(self, mask, images, min_area_frac, head_frac, seed_frame="largest_mask"):
        m = mask if mask.dim() == 3 else mask.unsqueeze(0)
        H, W = images.shape[1], images.shape[2]
        n = min(m.shape[0], images.shape[0])
        area = (m[:n] > 0.5).flatten(1).float().mean(1)
        hit = torch.nonzero(area >= min_area_frac).flatten()
        if hit.numel() == 0:
            raise ValueError("CJSubjectFaceSeed: mask is empty on every frame")
        f = int(hit[0]) if seed_frame == "first_visible" else int(torch.argmax(area))
        cx, cy = _head_point(m[f], head_frac)
        sx, sy = W / m.shape[2], H / m.shape[1]
        X, Y = int(round(cx * sx)), int(round(cy * sy))
        return (X, Y, f, f"seed frame={f} xy=({X},{Y}) on {W}x{H}, mask area={float(area[f]):.4f}")


class CJMaskedFaceClamp:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "base_images": ("IMAGE",),
            "polished_images": ("IMAGE",),
            "mask": ("MASK",),
            "dilation_px": ("INT", {"default": 16, "min": 0, "max": 256}),
            "feather_px": ("INT", {"default": 12, "min": 0, "max": 256}),
        }}

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("images", "report")
    FUNCTION = "run"
    CATEGORY = "cj/h3"

    def run(self, base_images, polished_images, mask, dilation_px, feather_px):
        B, H, W, _ = base_images.shape
        n = min(B, polished_images.shape[0])
        m = mask if mask.dim() == 3 else mask.unsqueeze(0)
        if m.shape[0] == 1 and n > 1:
            m = m.expand(n, -1, -1)
        m = m[:n].float().unsqueeze(1).to(base_images.device)
        if m.shape[-2:] != (H, W):
            m = F.interpolate(m, size=(H, W), mode="bilinear", align_corners=False)
        m = (m > 0.5).float()
        if dilation_px > 0:
            k = 2 * dilation_px + 1
            m = F.max_pool2d(m, k, stride=1, padding=dilation_px)
        if feather_px > 0:
            k = 2 * feather_px + 1
            m = F.avg_pool2d(F.pad(m, (feather_px,) * 4, mode="replicate"), k, stride=1)
        w = m.squeeze(1).unsqueeze(-1).to(base_images.dtype)
        base = base_images[:n, ..., :3]
        delta = polished_images[:n, ..., :3].to(base.dtype) - base
        out = base_images[..., :3].clone()
        out[:n] = base + delta * w
        mag = delta.abs().sum(-1)
        total = mag.flatten(1).sum(1).clamp_min(1e-6)
        outside = (mag * (1 - w.squeeze(-1))).flatten(1).sum(1) / total
        changed = mag.flatten(1).sum(1) > 1e-3
        frac = outside[changed]
        worst = int(torch.argmax(outside)) if n else -1
        rep = (f"clamp: {int(changed.sum())}/{n} frames changed; change discarded outside mask "
               f"mean={float(frac.mean()) if frac.numel() else 0:.3f} max={float(outside.max()) if n else 0:.3f} "
               f"(frame {worst}); >0.5 on {int((frac > 0.5).sum())} frames = tracker likely on another face")
        print("[CJMaskedFaceClamp]", rep)
        return (out, rep)


NODE_CLASS_MAPPINGS = {"CJSubjectFaceSeed": CJSubjectFaceSeed, "CJMaskedFaceClamp": CJMaskedFaceClamp}
NODE_DISPLAY_NAME_MAPPINGS = {"CJSubjectFaceSeed": "Subject Face Seed (from mask)",
                              "CJMaskedFaceClamp": "Masked Face Clamp (per subject)"}

"""per-instance RGBA cutouts + a labelled contact sheet (Breakdown tool).

Input: one IMAGE and up to 8 MASK batches, one per part (e.g. SAM3_Detect with individual_masks=True,
which returns [N_obj, H, W] per prompt, N_obj may be 0). `labels` names the batches in order
("person, clothing, bag"). Every mask becomes one candidate; candidates smaller than min_area_frac of
the frame are dropped, and a candidate whose IoU with an earlier kept one exceeds dedupe_iou is dropped
(earlier input = higher priority; SAM3 orders each part's masks by score).

Saved: the contact sheet first (so it is the job's first image), then each cutout cropped to its bbox
plus padding as an RGBA PNG (alpha = mask, feathered by 1 px)."""
import logging
import re

import cv2
import numpy as np

_log = logging.getLogger("cj_image_tools")

MAX_PARTS = 8


def _clean_label(s, fallback):
    s = re.sub(r":\s*[\d.]+\s*$", "", str(s or "")).strip()          # drop SAM3 ":N" max-detection suffix
    s = re.sub(r"[^A-Za-z0-9 _\-/&']", "", s)[:28].strip()
    return s or fallback


def parse_labels(labels, n):
    parts = [p for p in re.split(r"[,\n]", labels or "")]
    return [_clean_label(parts[i] if i < len(parts) else "", f"part {i + 1}") for i in range(n)]


def select_instances(mask_groups, labels, hw, min_area_frac=0.002, dedupe_iou=0.85, max_cutouts=24):
    """mask_groups: list of float arrays [N,H',W'] (any N incl. 0). -> list of (label, bool mask HxW)."""
    H, W = hw
    min_area = max(16, int(min_area_frac * H * W))
    kept, out = [], []
    for g, group in enumerate(mask_groups):
        if group is None:
            continue
        group = np.asarray(group, np.float32)
        if group.ndim == 2:
            group = group[None]
        idx = 0
        for m in group:
            if m.shape != (H, W):
                m = cv2.resize(m, (W, H), interpolation=cv2.INTER_LINEAR)
            mb = m > 0.5
            area = int(mb.sum())
            if area < min_area:
                continue
            dup = False
            for km in kept:
                inter = np.logical_and(km, mb).sum()
                if inter and inter / float(np.logical_or(km, mb).sum()) > dedupe_iou:
                    dup = True
                    break
            if dup:
                continue
            idx += 1
            kept.append(mb)
            out.append((f"{labels[g]} {idx}", mb))
            if len(out) >= max_cutouts:
                return out
    return out


def cutout(rgb, mask, pad):
    """-> RGBA uint8 crop of rgb to mask bbox + pad, alpha = mask (1 px feather), bbox (x0,y0,x1,y1)."""
    H, W = mask.shape
    ys, xs = np.nonzero(mask)
    x0, x1 = max(0, xs.min() - pad), min(W, xs.max() + 1 + pad)
    y0, y1 = max(0, ys.min() - pad), min(H, ys.max() + 1 + pad)
    a = cv2.GaussianBlur(mask[y0:y1, x0:x1].astype(np.float32), (3, 3), 0.7)
    rgba = np.dstack([rgb[y0:y1, x0:x1], np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8)])
    return rgba, (int(x0), int(y0), int(x1), int(y1))


def _checker(h, w, s=12):
    yy, xx = np.mgrid[0:h, 0:w]
    v = np.where(((yy // s) + (xx // s)) % 2 == 0, 58, 44).astype(np.uint8)
    return np.dstack([v, v, v])


def contact_sheet(cutouts, labels, cell=256, label_h=28, cols=None, empty_text="nothing found"):
    """RGBA cutouts -> uint8 RGB grid, each fitted on a checkerboard cell with its label underneath."""
    n = len(cutouts)
    if n == 0:
        img = np.full((cell, cell * 2, 3), 32, np.uint8)
        cv2.putText(img, empty_text, (16, cell // 2), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (220, 220, 220), 2, cv2.LINE_AA)
        return img
    cols = cols or int(min(n, max(1, round(np.sqrt(n * 1.4)))))
    rows = (n + cols - 1) // cols
    gap = 8
    sheet = np.full((rows * (cell + label_h + gap) + gap, cols * (cell + gap) + gap, 3), 24, np.uint8)
    for i, (rgba, lab) in enumerate(zip(cutouts, labels)):
        r, c = divmod(i, cols)
        y, x = gap + r * (cell + label_h + gap), gap + c * (cell + gap)
        h, w = rgba.shape[:2]
        s = min(cell / h, cell / w)
        nh, nw = max(1, int(h * s)), max(1, int(w * s))
        im = cv2.resize(rgba, (nw, nh), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
        tile = _checker(cell, cell).astype(np.float32)
        oy, ox = (cell - nh) // 2, (cell - nw) // 2
        a = im[..., 3:4].astype(np.float32) / 255.0
        region = tile[oy:oy + nh, ox:ox + nw]
        tile[oy:oy + nh, ox:ox + nw] = im[..., :3] * a + region * (1 - a)
        sheet[y:y + cell, x:x + cell] = tile.astype(np.uint8)
        scale, th = 0.55, 1
        (tw, _), _ = cv2.getTextSize(lab, cv2.FONT_HERSHEY_SIMPLEX, scale, th)
        cv2.putText(sheet, lab, (x + max(0, (cell - tw) // 2), y + cell + label_h - 9),
                    cv2.FONT_HERSHEY_SIMPLEX, scale, (230, 230, 230), th, cv2.LINE_AA)
    return sheet


def breakdown(rgb, mask_groups, labels="", pad=16, min_area_frac=0.002, dedupe_iou=0.85, max_cutouts=24, cell=256):
    names = parse_labels(labels, len(mask_groups))
    inst = select_instances(mask_groups, names, rgb.shape[:2], min_area_frac, dedupe_iou, max_cutouts)
    cuts = [cutout(rgb, m, pad) for _, m in inst]
    sheet = contact_sheet([c for c, _ in cuts], [lab for lab, _ in inst], cell)
    return sheet, [(lab, c, box) for (lab, _), (c, box) in zip(inst, cuts)]


class CJCutouts:
    @classmethod
    def INPUT_TYPES(cls):
        opt = {f"masks_{i}": ("MASK",) for i in range(2, MAX_PARTS + 1)}
        return {
            "required": {
                "image": ("IMAGE",),
                "masks": ("MASK", {"tooltip": "per-instance masks [N,H,W] for part 1 (SAM3_Detect individual_masks)"}),
                "labels": ("STRING", {"default": "", "multiline": False,
                           "tooltip": "comma-separated part names, one per masks input, in order"}),
                "pad_px": ("INT", {"default": 16, "min": 0, "max": 256}),
                "min_area_frac": ("FLOAT", {"default": 0.002, "min": 0.0, "max": 0.5, "step": 0.0005}),
                "dedupe_iou": ("FLOAT", {"default": 0.85, "min": 0.1, "max": 1.0, "step": 0.01}),
                "max_cutouts": ("INT", {"default": 24, "min": 1, "max": 64}),
                "filename_prefix": ("STRING", {"default": "CJ_Breakdown/part"}),
            },
            "optional": opt,
        }

    RETURN_TYPES = ("IMAGE", "INT")
    RETURN_NAMES = ("contact_sheet", "count")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "image/detection"

    def run(self, image, masks, labels="", pad_px=16, min_area_frac=0.002, dedupe_iou=0.85, max_cutouts=24,
            filename_prefix="CJ_Breakdown/part", **more):
        import os

        import folder_paths
        import torch
        from PIL import Image

        rgb = (image[0, ..., :3].clamp(0, 1).cpu().numpy() * 255.0 + 0.5).astype(np.uint8)
        groups = [masks] + [more.get(f"masks_{i}") for i in range(2, MAX_PARTS + 1)]
        # labels follow the connected inputs in order; trailing unconnected slots are dropped
        while len(groups) > 1 and groups[-1] is None:
            groups.pop()
        groups = [None if g is None else g.detach().float().cpu().numpy() for g in groups]
        sheet, parts = breakdown(rgb, groups, labels, pad_px, min_area_frac, dedupe_iou, max_cutouts)

        out_dir = folder_paths.get_output_directory()
        full, name, counter, sub, _ = folder_paths.get_save_image_path(filename_prefix, out_dir, rgb.shape[1], rgb.shape[0])
        ui = []
        files = [("sheet", Image.fromarray(sheet))]
        for lab, rgba, _ in parts:
            files.append((re.sub(r"[^a-z0-9]+", "-", lab.lower()).strip("-") or "part", Image.fromarray(np.ascontiguousarray(rgba))))
        for j, (tag, im) in enumerate(files):
            fname = f"{name}_{counter:05}_{j:02}_{tag}.png"
            im.save(os.path.join(full, fname), compress_level=4)
            ui.append({"filename": fname, "subfolder": sub, "type": "output"})
        _log.info("CJCutouts: %d cutouts from %d mask inputs", len(parts), len(groups))
        sheet_t = torch.from_numpy(sheet.astype(np.float32) / 255.0)[None]
        return {"ui": {"images": ui}, "result": (sheet_t, len(parts))}


NODE_CLASS_MAPPINGS = {"CJCutouts": CJCutouts}
NODE_DISPLAY_NAME_MAPPINGS = {"CJCutouts": "Cutouts + Contact Sheet"}

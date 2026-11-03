"""CPU unit test for cj_cutouts.  usage: python -I test_cutouts.py

Synthetic masks: two parts, one with a near-duplicate (IoU > 0.85) and a tiny speck, one empty (0,H,W)
group, a low-res mask that must be resized. Checks dedupe, size filter, labels (incl. ':N' stripping),
RGBA crop/alpha/padding, contact sheet, and the ComfyUI node's saved files + ui + result."""
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _fake_comfy  # noqa: E402

co = _fake_comfy.load("cj_cutouts.py")

H, W = 300, 400
rgb = np.zeros((H, W, 3), np.uint8)
rgb[:] = (200, 210, 220)
cv2.circle(rgb, (100, 150), 60, (200, 40, 40), -1)
cv2.rectangle(rgb, (250, 80), (350, 220), (40, 60, 200), -1)


def disc(cx, cy, r, h=H, w=W):
    m = np.zeros((h, w), np.float32)
    cv2.circle(m, (cx, cy), r, 1.0, -1)
    return m


def rect(x0, y0, x1, y1):
    m = np.zeros((H, W), np.float32)
    m[y0:y1, x0:x1] = 1.0
    return m


person = np.stack([disc(100, 150, 60), disc(101, 151, 60), disc(20, 20, 2)])  # dup (IoU~0.97) + tiny speck
bag = np.stack([rect(250, 80, 351, 221)])
empty = np.zeros((0, H, W), np.float32)
lowres = disc(100, 75, 20, h=H // 2, w=W // 2)[None]                       # resized to HxW -> different place

# labels: ':N' stripped, unsafe chars removed, missing names get a fallback
assert co.parse_labels("person:4, bag, <b>ox!", 4) == ["person", "bag", "box", "part 4"], co.parse_labels("person:4, bag, <b>ox!", 4)

inst = co.select_instances([person, empty, bag, lowres], ["person", "hat", "bag", "ball"], (H, W))
labs = [lab for lab, _ in inst]
assert labs == ["person 1", "bag 1", "ball 1"], labs

# a bag mask identical to the person disc is dropped across groups too (earlier group wins)
inst2 = co.select_instances([person[:1], person[1:2]], ["person", "bag"], (H, W))
assert [lab for lab, _ in inst2] == ["person 1"], inst2
# dedupe threshold is respected: at 0.99 the near-duplicate survives
inst3 = co.select_instances([person[:2]], ["person"], (H, W), dedupe_iou=0.99)
assert len(inst3) == 2, len(inst3)
# max_cutouts caps the list
assert len(co.select_instances([person, bag, lowres], ["a", "b", "c"], (H, W), max_cutouts=2)) == 2

sheet, parts = co.breakdown(rgb, [person, empty, bag], "person:4, hat, bag", pad=10)
assert [p[0] for p in parts] == ["person 1", "bag 1"], [p[0] for p in parts]
lab, rgba, box = parts[0]
assert box == (30, 80, 171, 221), box                                       # bbox 40..160 / 90..210 + 10 pad
assert rgba.shape == (141, 141, 4) and rgba.dtype == np.uint8, rgba.shape
assert rgba[70, 70, 3] == 255 and rgba[2, 2, 3] == 0, (rgba[70, 70, 3], rgba[2, 2, 3])
assert tuple(rgba[70, 70, :3]) == (200, 40, 40), rgba[70, 70, :3]
assert 0 < rgba[70, 10, 3] < 255 or rgba[70, 10, 3] in (0, 255)                # 1 px feather, edge column
_, rgba_b, box_b = parts[1]
assert box_b == (240, 70, 361, 231), box_b
assert sheet.ndim == 3 and sheet.shape[2] == 3 and sheet.dtype == np.uint8
assert sheet.shape[0] >= 256 and sheet.shape[1] >= 2 * 256, sheet.shape
# the red disc shows up in the first tile
tile = sheet[8:8 + 256, 8:8 + 256].astype(int)
assert (np.abs(tile - np.array([200, 40, 40])).max(-1) < 30).sum() > 10000

# nothing found -> placeholder sheet, no parts
sheet0, parts0 = co.breakdown(rgb, [empty], "person")
assert parts0 == [] and sheet0.shape == (256, 512, 3), sheet0.shape

# ComfyUI node
import torch  # noqa: E402
from PIL import Image  # noqa: E402

out = _fake_comfy.fake_folder_paths()
img_t = torch.from_numpy(rgb.astype(np.float32) / 255)[None]
res = co.CJCutouts().run(img_t, torch.from_numpy(person), labels="person:4, clothing, bag", pad_px=10,
                          masks_2=torch.from_numpy(empty), masks_3=torch.from_numpy(bag))
ui, (sheet_t, count) = res["ui"], res["result"]
assert count == 2, count
names = [e["filename"] for e in ui["images"]]
assert len(names) == 3 and names[0].endswith("_00_sheet.png"), names
assert names[1].endswith("_01_person-1.png") and names[2].endswith("_02_bag-1.png"), names
assert sheet_t.ndim == 4 and sheet_t.shape[0] == 1 and sheet_t.shape[-1] == 3, sheet_t.shape
im = Image.open(os.path.join(out, ui["images"][1]["subfolder"], names[1]))
assert im.mode == "RGBA" and im.size == (141, 141), (im.mode, im.size)
assert ui["images"][1]["subfolder"] == "CJ_Breakdown"

# single connected input, trailing optional slots absent
res1 = co.CJCutouts().run(img_t, torch.from_numpy(bag), labels="bag")
assert res1["result"][1] == 1 and res1["ui"]["images"][1]["filename"].endswith("_bag-1.png")
print("OK test_cutouts")

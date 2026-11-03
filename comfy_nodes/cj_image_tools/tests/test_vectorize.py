"""CPU unit test for cj_vectorize.  usage: python -I test_vectorize.py

Synthetic flat art (background, red ring = disc with a hole, a yellow island inside the hole, blue rotated
square, green triangle): the SVG must parse, every shape must be a <path> with fill-rule evenodd, and the
preview rendered back from the SVG must match the input per colour (IoU) and overall (pixel agreement).
Also: a noisy 'photo-poster' input traces into a bounded palette, the parser handles relative commands +
translate, engine=vtracer falls back when the package is missing, and the ComfyUI node writes the .svg +
preview .png and reports both in its ui dict."""
import os
import sys
import xml.etree.ElementTree as ET

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _fake_comfy  # noqa: E402

vz = _fake_comfy.load("cj_vectorize.py")

H, W = 420, 560
BG, RED, BLUE, GREEN, YEL = (245, 240, 230), (210, 30, 40), (30, 70, 200), (40, 160, 70), (240, 200, 20)
img = np.zeros((H, W, 3), np.uint8)
img[:] = BG
cv2.circle(img, (160, 170), 110, RED, -1)
cv2.circle(img, (160, 170), 50, BG, -1)                                    # hole -> evenodd
cv2.circle(img, (160, 170), 18, YEL, -1)                                   # island inside the hole
box = cv2.boxPoints(((410, 140), (150, 150), 25)).astype(np.int32)
cv2.fillPoly(img, [box], BLUE)
cv2.fillPoly(img, [np.array([[300, 400], [520, 400], [410, 260]], np.int32)], GREEN)
cols = [BG, RED, BLUE, GREEN, YEL]


def label_of(im):
    d = ((im[:, :, None, :].astype(int) - np.array(cols)[None, None]) ** 2).sum(-1)
    return d.argmin(-1)


def near(px, col, tol=24):
    return int(np.abs(px.astype(int) - np.array(col)).max()) < tol


def check(svg, prev, src, min_iou, min_agree, tag):
    root = ET.fromstring(svg)                                              # parses
    assert root.tag.endswith("svg") and root.get("viewBox"), tag
    paths = [e for e in root.iter() if e.tag.endswith("path")]
    assert paths and all(p.get("fill-rule") == "evenodd" for p in paths), tag
    assert prev.shape == src.shape and prev.dtype == np.uint8, (tag, prev.shape)
    a, b = label_of(src), label_of(prev)
    agree = float((a == b).mean())
    ious = []
    for k in range(len(cols)):
        inter, union = np.logical_and(a == k, b == k).sum(), np.logical_or(a == k, b == k).sum()
        if union:
            # anti-aliased edge pixels dominate a tiny shape's IoU: hold small shapes to a looser bar
            ious.append(inter / union if (a == k).sum() > 5000 else min(1.0, inter / union + 0.08))
    print(f"{tag}: paths={len(paths)} bytes={len(svg)} agree={agree:.4f} iou_min={min(ious):.4f} "
          f"ious={[round(float(x), 3) for x in ious]}")
    assert agree >= min_agree, (tag, agree)
    assert min(ious) >= min_iou, (tag, ious)


for preset in ("logo", "illustration", "poster"):
    svg, prev, used = vz.vectorize(img, preset=preset, colors=5)
    assert used == "opencv"
    check(svg, prev, img, 0.90 if preset != "poster" else 0.85, 0.97 if preset != "poster" else 0.95, preset)

# the hole is a hole (background between hole edge and island), the island is filled, the ring is red
svg, prev, _ = vz.vectorize(img, preset="logo", colors=5)
assert near(prev[170, 194], BG), prev[170, 194]
assert near(prev[170, 160], YEL), prev[170, 160]
assert near(prev[170, 240], RED), prev[170, 240]

# downscaled working size: viewBox smaller, width/height = original, preview at original size
svg2, prev2, _ = vz.vectorize(img, preset="logo", colors=5, max_side=280)
r2 = ET.fromstring(svg2)
assert (r2.get("width"), r2.get("height")) == (str(W), str(H)), (r2.get("width"), r2.get("height"))
assert r2.get("viewBox") == "0 0 280 210", r2.get("viewBox")
check(svg2, prev2, img, 0.60, 0.97, "downscaled")  # 9 px island at half res: loose IoU

# noisy photo-like input still traces into a bounded number of colours
rng = np.random.default_rng(1)
noisy = np.clip(img.astype(np.float32) + rng.normal(0, 14, img.shape), 0, 255).astype(np.uint8)
svg3, prev3, _ = vz.vectorize(noisy, preset="poster", colors=6)
fills = {e.get("fill") for e in ET.fromstring(svg3).iter() if e.get("fill")}
assert len(fills) <= 6, fills
check(svg3, prev3, img, 0.80, 0.93, "noisy-poster")

# parser: relative commands, H/V, translate (vtracer writes translate + absolute C)
t = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">'
     '<path fill="#ff0000" d="m10 10h20v20h-20z" />'
     '<path fill="#0000ff" transform="translate(15,15)" d="M0 0 L10 0 L10 10 L0 10 Z" /></svg>')
r = vz.rasterize_svg(t)
assert tuple(r[12, 12]) == (255, 0, 0) and tuple(r[20, 20]) == (0, 0, 255) and tuple(r[5, 5]) == (255, 255, 255), \
    (r[12, 12], r[20, 20], r[5, 5])

# engine=vtracer without the package falls back to opencv
try:
    import vtracer  # noqa: F401
    have_vt = True
except ImportError:
    have_vt = False
_, _, used = vz.vectorize(img, preset="logo", colors=5, engine="vtracer")
assert used == ("vtracer" if have_vt else "opencv"), used

# ComfyUI node: writes .svg + .png, ui has images (png) + svg (file entry), result preview tensor
import torch  # noqa: E402

out = _fake_comfy.fake_folder_paths()
res = vz.CJVectorize().run(torch.from_numpy(img.astype(np.float32) / 255)[None], preset="logo", colors=5)
ui, (preview_t, svg_path) = res["ui"], res["result"]
assert ui["images"][0]["filename"].endswith(".png") and ui["svg"][0]["filename"].endswith(".svg"), ui
assert tuple(preview_t.shape) == (1, H, W, 3), preview_t.shape
svg_file = os.path.join(out, ui["svg"][0]["subfolder"], ui["svg"][0]["filename"])
ET.parse(svg_file)
assert svg_path == os.path.join("CJ_Vector", ui["svg"][0]["filename"]), svg_path
print("OK test_vectorize")

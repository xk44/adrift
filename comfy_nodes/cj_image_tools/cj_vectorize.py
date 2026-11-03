"""raster image -> SVG (Vector tool).

Two engines, same output contract (an SVG file + a rasterized preview IMAGE):
  opencv   (default, zero installs) k-means colour quantization in Lab -> speckle merge -> per-colour masks
           -> RETR_CCOMP contours (outer + holes, fill-rule evenodd) -> approxPolyDP -> optional cubic
           smoothing (Catmull-Rom -> Bezier, sharp corners kept) -> one <path> per colour, largest first.
  vtracer  (optional, `pip install vtracer`) used when engine = vtracer and it imports; on any failure the
           node logs and falls back to opencv.

The preview is rendered FROM the SVG text by a small path parser (M/L/H/V/C/Z, absolute + relative,
translate transforms), so it shows what the SVG contains, whichever engine wrote it."""
import logging
import re
import xml.etree.ElementTree as ET

import cv2
import numpy as np

_log = logging.getLogger("cj_image_tools")

# colors: palette size; eps: approxPolyDP tolerance (px at working res); min_area: speckle size (px);
# smooth: cubic smoothing on/off; corner_deg: turn angle above which a vertex stays sharp; blur: prefilter.
PRESETS = {
    "logo": dict(colors=6, eps=0.9, min_area=24, smooth=True, corner_deg=55.0, blur="median", mode_r=1),
    "illustration": dict(colors=16, eps=1.1, min_area=36, smooth=True, corner_deg=70.0, blur="bilateral", mode_r=1),
    "poster": dict(colors=24, eps=1.4, min_area=64, smooth=True, corner_deg=80.0, blur="poster", mode_r=2),
}


# quantize
def quantize(rgb, k, seed=0):
    """uint8 HxWx3 -> (labels HxW int32, palette kx3 uint8 RGB). k-means in Lab on a pixel sample."""
    h, w = rgb.shape[:2]
    lab = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.float32)
    rng = np.random.default_rng(seed)
    n = lab.shape[0]
    sample = lab[rng.choice(n, size=min(n, 120_000), replace=False)] if n > 120_000 else lab
    k = int(max(2, min(k, len(np.unique(sample.round().astype(np.int32), axis=0)))))
    cv2.setRNGSeed(seed)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5)
    _, _, centers = cv2.kmeans(sample, k, None, crit, 3, cv2.KMEANS_PP_CENTERS)
    labels = np.empty(n, np.int32)
    for s in range(0, n, 1 << 20):                                   # nearest centre, chunked
        d = ((lab[s:s + (1 << 20), None, :] - centers[None]) ** 2).sum(-1)
        labels[s:s + (1 << 20)] = d.argmin(1)
    pal_lab = np.clip(centers, 0, 255).astype(np.uint8).reshape(-1, 1, 3)
    palette = cv2.cvtColor(pal_lab, cv2.COLOR_LAB2RGB).reshape(-1, 3)
    return labels.reshape(h, w), palette


def _fill_unknown(labels, unknown):
    """Give every unknown pixel the label of its nearest known pixel."""
    if not unknown.any():
        return labels
    if unknown.all():
        return np.zeros_like(labels)
    try:
        from scipy import ndimage
        _, (iy, ix) = ndimage.distance_transform_edt(unknown, return_indices=True)
        return labels[iy, ix]
    except ImportError:
        out = labels.copy()
        out[unknown] = -1
        for _ in range(256):                                         # 4-neighbour flood, no scipy
            todo = out < 0
            if not todo.any():
                break
            for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                nb = np.roll(out, (dy, dx), (0, 1))
                take = todo & (nb >= 0)
                out[take] = nb[take]
                todo &= ~take
        out[out < 0] = 0
        return out


def mode_filter(labels, radius):
    """Majority vote of the label map over a (2r+1)^2 window: straightens edges that quantization noise
    made ragged, which is most of an SVG's byte count on photo input."""
    if radius <= 0:
        return labels
    size = 2 * radius + 1
    best = np.full(labels.shape, -1.0, np.float32)
    out = labels.copy()
    for lab in np.unique(labels):
        votes = cv2.boxFilter((labels == lab).astype(np.float32), -1, (size, size), normalize=False,
                              borderType=cv2.BORDER_REPLICATE)
        take = votes > best
        best[take] = votes[take]
        out[take] = lab
    return out


def merge_speckles(labels, min_area):
    """Connected components smaller than min_area px are absorbed by their nearest neighbouring colour."""
    if min_area <= 1:
        return labels
    unknown = np.zeros(labels.shape, bool)
    for lab in np.unique(labels):
        n, cc, stats, _ = cv2.connectedComponentsWithStats((labels == lab).astype(np.uint8), connectivity=8)
        small = np.where(stats[1:, cv2.CC_STAT_AREA] < min_area)[0] + 1
        if small.size:
            unknown |= np.isin(cc, small)
    return _fill_unknown(labels, unknown)


# tracing
def _contours(mask):
    res = cv2.findContours(mask.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    contours, hier = res[-2], res[-1]
    return contours, (hier[0] if hier is not None else np.zeros((0, 4), np.int32))


def _fmt(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def ring_to_d(pts, smooth, corner_deg):
    """Closed polygon (Nx2 float) -> SVG subpath. Smooth = Catmull-Rom cubic, sharp at corners."""
    n = len(pts)
    if n < 3:
        return ""
    out = [f"M{_fmt(pts[0][0])} {_fmt(pts[0][1])}"]
    if not smooth or n < 4:
        out += [f"L{_fmt(x)} {_fmt(y)}" for x, y in pts[1:]]
        return "".join(out) + "Z"
    prev, nxt = np.roll(pts, 1, 0), np.roll(pts, -1, 0)
    a, b = pts - prev, nxt - pts
    cos = (a * b).sum(1) / (np.linalg.norm(a, axis=1) * np.linalg.norm(b, axis=1) + 1e-9)
    corner = np.degrees(np.arccos(np.clip(cos, -1, 1))) > corner_deg
    for i in range(n):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[(i + 1) % n], pts[(i + 2) % n]
        c1 = p1 if corner[i] else p1 + (p2 - p0) / 6.0
        c2 = p2 if corner[(i + 1) % n] else p2 - (p3 - p1) / 6.0
        out.append(f"C{_fmt(c1[0])} {_fmt(c1[1])} {_fmt(c2[0])} {_fmt(c2[1])} {_fmt(p2[0])} {_fmt(p2[1])}")
    return "".join(out) + "Z"


def trace_opencv(rgb, colors, eps, min_area, smooth, corner_deg, blur, mode_r=1, seed=0):
    """uint8 RGB -> SVG text (viewBox = rgb size)."""
    h, w = rgb.shape[:2]
    src = rgb
    if blur == "median":
        src = cv2.medianBlur(rgb, 3)
    elif blur == "bilateral":
        src = cv2.bilateralFilter(rgb, 7, 40, 7)
    elif blur == "poster":
        src = cv2.bilateralFilter(cv2.medianBlur(rgb, 5), 9, 60, 9)
    labels, palette = quantize(src, colors, seed)
    labels = merge_speckles(mode_filter(labels, mode_r), min_area)
    ids, areas = np.unique(labels, return_counts=True)
    order = ids[np.argsort(-areas)]
    rank_of = np.empty(int(labels.max()) + 1, np.int32)
    rank_of[order] = np.arange(len(order))
    ranks = rank_of[labels]
    paths = []
    for rank, lab in enumerate(order):
        r, g, b = (int(v) for v in palette[lab])
        fill = f"#{r:02x}{g:02x}{b:02x}"
        if rank == 0:                                                # dominant colour = full-canvas backdrop
            paths.append(f'<rect width="{w}" height="{h}" fill="{fill}"/>')
            continue
        # Stacked layers: this colour's shape also covers every smaller colour drawn after it, so the only
        # visible edges are against earlier layers -> no hairline gaps and simpler outlines.
        # Traced on a 2x nearest-upsampled mask: contour points sit 0.25 px inside the true pixel edge.
        mask = (ranks >= rank).astype(np.uint8)
        contours, hier = _contours(cv2.resize(mask, (w * 2, h * 2), interpolation=cv2.INTER_NEAREST))
        subpaths = []
        for i, c in enumerate(contours):
            if hier[i][3] != -1:
                continue                                             # holes are emitted with their parent
            ring = [c]
            child = hier[i][2]
            while child != -1:
                ring.append(contours[child])
                child = hier[child][0]
            for cc in ring:
                if cc is not c and cv2.contourArea(cc) < 4 * max(2.0, min_area * 0.25):
                    continue
                poly = (cv2.approxPolyDP(cc, eps * 2, True).reshape(-1, 2).astype(np.float64) + 0.5) / 2.0
                d = ring_to_d(poly, smooth, corner_deg)
                if d:
                    subpaths.append(d)
        if subpaths:
            paths.append(f'<path fill="{fill}" fill-rule="evenodd" d="{"".join(subpaths)}"/>')
    return svg_document(w, h, paths)


def svg_document(w, h, body, out_w=None, out_h=None):
    ow, oh = out_w or w, out_h or h
    return (f'<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="{ow}" height="{oh}" '
            f'viewBox="0 0 {w} {h}" shape-rendering="geometricPrecision">\n' + "\n".join(body) + "\n</svg>\n")


def trace_vtracer(rgb, colors, preset):
    import vtracer  # optional dependency
    h, w = rgb.shape[:2]
    rgba = np.dstack([rgb, np.full((h, w), 255, np.uint8)])
    precision = int(np.clip(np.ceil(np.log2(max(colors, 2))) + 2, 3, 8))
    p = PRESETS[preset]
    svg = vtracer.convert_pixels_to_svg(
        [tuple(int(v) for v in px) for px in rgba.reshape(-1, 4)], size=(w, h), colormode="color",
        hierarchical="stacked", mode="spline", filter_speckle=max(1, int(np.sqrt(p["min_area"]))),
        color_precision=precision, layer_difference=16, corner_threshold=int(p["corner_deg"]),
        length_threshold=4.0, max_iterations=10, splice_threshold=45, path_precision=2)
    if "viewBox" not in svg:
        svg = svg.replace("<svg ", f'<svg viewBox="0 0 {w} {h}" ', 1)
    return svg


# rasterize
_TOK = re.compile(r"[MmLlHhVvCcZzSsQqTtAa]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def _bezier(p0, c1, c2, p3, steps=8):
    t = np.linspace(0, 1, steps + 1)[1:, None]
    return ((1 - t) ** 3) * p0 + 3 * ((1 - t) ** 2) * t * c1 + 3 * (1 - t) * t * t * c2 + t ** 3 * p3


def parse_path(d):
    """SVG path d -> list of closed polylines (Nx2). Supports M L H V C Z (abs/rel); others raise."""
    toks = _TOK.findall(d)
    rings, cur, pos, start, cmd, i = [], [], np.zeros(2), np.zeros(2), None, 0

    def num():
        nonlocal i
        v = float(toks[i]); i += 1
        return v

    while i < len(toks):
        if toks[i].isalpha():
            cmd = toks[i]; i += 1
        elif cmd is None:
            raise ValueError("path data starts with a number")
        rel = cmd.islower()
        c = cmd.upper()
        base = pos if rel else np.zeros(2)
        if c == "M":
            if len(cur) > 2:
                rings.append(np.array(cur))
            pos = base + np.array([num(), num()]); start = pos.copy(); cur = [pos.copy()]
            cmd = "l" if rel else "L"                                # implicit lineto after moveto
        elif c == "L":
            pos = base + np.array([num(), num()]); cur.append(pos.copy())
        elif c == "H":
            pos = np.array([(pos[0] if rel else 0) + num(), pos[1]]); cur.append(pos.copy())
        elif c == "V":
            pos = np.array([pos[0], (pos[1] if rel else 0) + num()]); cur.append(pos.copy())
        elif c == "C":
            c1 = base + np.array([num(), num()]); c2 = base + np.array([num(), num()])
            p3 = base + np.array([num(), num()])
            cur.extend(_bezier(pos, c1, c2, p3)); pos = p3
        elif c == "Z":
            if len(cur) > 2:
                rings.append(np.array(cur))
            cur, pos = [], start.copy()
            cmd = None
        else:
            raise ValueError(f"unsupported path command {cmd}")
    if len(cur) > 2:
        rings.append(np.array(cur))
    return rings


def _color(s):
    s = (s or "").strip()
    m = re.fullmatch(r"#([0-9a-fA-F]{6})", s) or re.fullmatch(r"#([0-9a-fA-F]{3})", s)
    if not m:
        m2 = re.fullmatch(r"rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)", s)
        return tuple(int(v) for v in m2.groups()) if m2 else None
    hx = m.group(1)
    if len(hx) == 3:
        hx = "".join(ch * 2 for ch in hx)
    return tuple(int(hx[j:j + 2], 16) for j in (0, 2, 4))


def _translate(tr):
    m = re.search(r"translate\(\s*([-\d.eE]+)[\s,]*([-\d.eE]+)?\s*\)", tr or "")
    return np.array([float(m.group(1)), float(m.group(2) or 0)]) if m else np.zeros(2)


def rasterize_svg(svg, out_w=None, out_h=None):
    """Render <rect>/<path> fills of an SVG (as written by either engine) to uint8 RGB."""
    root = ET.fromstring(svg)
    vb = [float(v) for v in re.split(r"[\s,]+", root.get("viewBox", "").strip()) if v] or \
        [0, 0, float(root.get("width")), float(root.get("height"))]
    vw, vh = vb[2], vb[3]
    W, H = int(round(out_w or vw)), int(round(out_h or vh))
    sx, sy = W / vw, H / vh
    sub = 4                                                          # fillPoly fixed-point subpixel shift
    img = np.full((H, W, 3), 255, np.uint8)
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1]
        col = _color(el.get("fill"))
        if col is None:
            continue
        off = _translate(el.get("transform"))
        if tag == "rect":
            x, y = float(el.get("x", 0)) + off[0], float(el.get("y", 0)) + off[1]
            rw, rh = float(el.get("width", vw)), float(el.get("height", vh))
            rings = [np.array([[x, y], [x + rw, y], [x + rw, y + rh], [x, y + rh]])]
        elif tag == "path":
            rings = [r + off for r in parse_path(el.get("d", ""))]
        else:
            continue
        pts = [np.round((r - vb[:2]) * [sx, sy] * (1 << sub)).astype(np.int32) for r in rings]
        if pts:
            cv2.fillPoly(img, pts, col, lineType=cv2.LINE_AA, shift=sub)  # alternating rule = evenodd holes
    return img


# driver
def vectorize(rgb, preset="logo", colors=0, engine="opencv", detail=1.0, max_side=1600, seed=0):
    """uint8 RGB -> (svg text, preview uint8 RGB at the input size, engine actually used)."""
    p = dict(PRESETS.get(preset, PRESETS["logo"]))
    if colors and colors > 0:
        p["colors"] = int(colors)
    detail = float(np.clip(detail, 0.25, 4.0))
    p["eps"] = p["eps"] / detail
    p["min_area"] = max(1, int(round(p["min_area"] / detail)))
    h, w = rgb.shape[:2]
    s = min(1.0, max_side / max(h, w))
    work = cv2.resize(rgb, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA) if s < 1 else rgb
    svg, used = None, "opencv"
    if engine == "vtracer":
        try:
            svg, used = trace_vtracer(work, p["colors"], preset), "vtracer"
            rasterize_svg(svg, 8, 8)                                 # parseable by our renderer?
        except Exception:
            _log.warning("CJVectorize: vtracer unavailable or failed; using the OpenCV tracer", exc_info=True)
            svg, used = None, "opencv"
    if svg is None:
        svg = trace_opencv(work, p["colors"], p["eps"], p["min_area"], p["smooth"], p["corner_deg"], p["blur"], p["mode_r"], seed)
    if s < 1:                                                        # display size = the original's size
        svg = re.sub(r'(<svg[^>]*?)\swidth="[^"]*"\s+height="[^"]*"', rf'\1 width="{w}" height="{h}"', svg, count=1)
    preview = rasterize_svg(svg, w, h)
    return svg, preview, used


class CJVectorize:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "preset": (list(PRESETS.keys()), {"default": "logo",
                           "tooltip": "logo: few flat colours, sharp corners; illustration: more colours, smooth "
                                      "curves; poster: photo to flat poster art"}),
                "colors": ("INT", {"default": 0, "min": 0, "max": 64,
                           "tooltip": "palette size; 0 = the preset's default (logo 6, illustration 16, poster 24)"}),
                "detail": ("FLOAT", {"default": 1.0, "min": 0.25, "max": 4.0, "step": 0.05,
                           "tooltip": ">1 keeps smaller shapes and tighter curves (bigger file)"}),
                "engine": (["opencv", "vtracer"], {"default": "opencv",
                           "tooltip": "vtracer needs `pip install vtracer`; falls back to opencv"}),
                "max_side": ("INT", {"default": 1600, "min": 256, "max": 4096, "step": 64}),
                "filename_prefix": ("STRING", {"default": "CJ_Vector/vector"}),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("preview", "svg_path")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "image/vector"

    def run(self, image, preset="logo", colors=0, detail=1.0, engine="opencv", max_side=1600,
            filename_prefix="CJ_Vector/vector"):
        import os

        import folder_paths
        import torch
        from PIL import Image

        out_dir = folder_paths.get_output_directory()
        previews, svgs, ui_images, paths = [], [], [], []
        for b in range(image.shape[0]):
            rgb = (image[b, ..., :3].clamp(0, 1).cpu().numpy() * 255.0 + 0.5).astype(np.uint8)
            svg, prev, used = vectorize(rgb, preset, colors, engine, detail, max_side)
            full, name, counter, sub, _ = folder_paths.get_save_image_path(filename_prefix, out_dir, rgb.shape[1], rgb.shape[0])
            base = f"{name}_{counter:05}_"
            with open(os.path.join(full, base + ".svg"), "w", encoding="utf-8") as f:
                f.write(svg)
            Image.fromarray(prev).save(os.path.join(full, base + ".png"), compress_level=4)
            svgs.append({"filename": base + ".svg", "subfolder": sub, "type": "output"})
            ui_images.append({"filename": base + ".png", "subfolder": sub, "type": "output"})
            paths.append(os.path.join(sub, base + ".svg") if sub else base + ".svg")
            previews.append(torch.from_numpy(prev.astype(np.float32) / 255.0))
            _log.info("CJVectorize: %s (%s, %d bytes)", base + ".svg", used, len(svg))
        # "images" = the preview PNG (the job's image); "svg" = the vector file (Adrift lists it as a download)
        return {"ui": {"images": ui_images, "svg": svgs},
                "result": (torch.stack(previews), "\n".join(paths))}


NODE_CLASS_MAPPINGS = {"CJVectorize": CJVectorize}
NODE_DISPLAY_NAME_MAPPINGS = {"CJVectorize": "Vectorize to SVG"}

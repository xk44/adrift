"""CPU test for cj_video_palette (numpy + ffmpeg on PATH).  usage: python test_video_palette.py path/to/cj_video_palette.py"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

spec = importlib.util.spec_from_file_location("vp", sys.argv[1])
vp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vp)

rng = np.random.default_rng(0)

# -- colour math: OKLab round trip, gamut fit keeps in-gamut colours and clamps the rest into 0..1
rgb = rng.random((500, 3))
assert np.allclose(vp.oklab_to_srgb(vp.srgb_to_oklab(rgb)), rgb, atol=1e-6)
wild = np.array([[0.7, 0.4, 0.4], [0.5, -0.3, 0.3]])
out = vp.oklab_to_srgb(wild)
assert out.min() >= 0 and out.max() <= 1
assert abs(vp.srgb_to_oklab(out)[0, 0] - 0.7) < 0.02, "gamut fit keeps lightness"

# -- palette parsing
cols, w = vp.parse_palette("#ff0000, #00f:3; 0000ff")
assert cols.shape == (3, 3) and np.allclose(w, [0.2, 0.6, 0.2]) and np.allclose(cols[1], [0, 0, 1])
cols, w = vp.parse_palette(json.dumps([{"hex": "#112233", "weight": 2}, "#445566"]))
assert cols.shape == (2, 3) and np.allclose(w, [2 / 3, 1 / 3])
assert vp.parse_palette("  ") == (None, None)
for bad in ["#12345", "#gg0000", "#ff0000:0", ", ".join(["#000000"] * 17)]:
    try:
        vp.parse_palette(bad)
    except ValueError:
        pass
    else:
        raise AssertionError(f"parse_palette accepted {bad!r}")

# synthetic clip: smooth colour field + a moving bright square (the square changes per-frame colour stats)
H, W, N = 48, 64, 12
yy, xx = np.mgrid[0:H, 0:W]
base = np.stack([xx / W, yy / H, 0.5 + 0.3 * np.sin(xx / 7.0)], axis=-1)
frames = np.empty((N, H, W, 3), np.uint8)
for i in range(N):
    f = base.copy()
    x0 = 4 + i * 4
    f[8:24, x0:x0 + 12] = [1.0, 0.9, 0.2]
    frames[i] = np.clip(np.rint(f * 255), 0, 255).astype(np.uint8)
teal_orange = vp.parse_palette("#0b3c49, #1f7a8c, #e07a2f, #f2c48d")

# -- strength 0 is an exact identity (fit, LUT bake, 256^3 expansion, lookup)
g0 = vp.fit_grade(frames, palette=teal_orange, strength=0.0)
table0 = vp.expand_lut(g0.lut())
for f in frames:
    assert np.array_equal(vp.apply_table(f, table0), f)

# -- the grade actually moves colours toward the palette, monotonic in strength
def mean_dist_to_palette(img, pal):
    lab = vp.srgb_to_oklab(img.reshape(-1, 3) / 255.0)
    pl = vp.srgb_to_oklab(pal)
    return np.sqrt(((lab[:, None, 1:] - pl[None, :, 1:]) ** 2).sum(-1)).min(1).mean()

d = []
for s in (0.0, 0.5, 1.0):
    t = vp.expand_lut(vp.fit_grade(frames, palette=teal_orange, strength=s).lut())
    d.append(mean_dist_to_palette(vp.apply_table(frames[0], t), teal_orange[0]))
assert d[0] > d[1] > d[2], d

# -- temporal stability: ONE table for the clip, so pixels that do not change never change in the output,
#    even though the moving square changes every frame's statistics (a per-frame refit would drift)
g = vp.fit_grade(frames, palette=teal_orange, strength=1.0)
table = vp.expand_lut(g.lut())
graded = np.stack([vp.apply_table(f, table) for f in frames])
static = np.ones((H, W), bool)
for i in range(N):
    static[8:24, 4 + i * 4:16 + i * 4] = False
assert static.sum() > 1000
ref_px = graded[0][static]
for i in range(1, N):
    assert np.array_equal(graded[i][static], ref_px), f"frame {i} flickered"
# contrast check: a per-frame refit WOULD drift on the static area (proves the test can see flicker)
drift = []
for i in (0, N - 1):
    t = vp.expand_lut(vp.fit_grade(frames[i:i + 1], palette=teal_orange, strength=1.0).lut())
    drift.append(vp.apply_table(frames[i], t)[static].astype(int))
assert np.abs(drift[0] - drift[1]).mean() > 0.5, "per-frame refit control should drift"

# -- preserve luminance keeps OKLab L; skin protect leaves skin tones nearly untouched
gl = vp.fit_grade(frames, palette=teal_orange, strength=1.0, preserve_luminance=True)
src = rng.random((400, 3)) * 0.8 + 0.1
L_src = vp.srgb_to_oklab(src)[:, 0]
L_out = vp.srgb_to_oklab(gl.apply_srgb(src))[:, 0]
assert np.abs(L_out - L_src).mean() < 0.01, np.abs(L_out - L_src).mean()
skin = np.array([[0.87, 0.67, 0.55], [0.76, 0.55, 0.42], [0.55, 0.37, 0.27], [0.95, 0.8, 0.7], [0.36, 0.22, 0.16]])
assert vp.skin_mask(vp.srgb_to_oklab(skin)).min() > 0.5
assert vp.skin_mask(vp.srgb_to_oklab(np.array([[0.1, 0.3, 0.9], [0.2, 0.8, 0.3], [0.95, 0.78, 0.1]]))).max() < 0.05
g_noskin = vp.fit_grade(frames, palette=teal_orange, strength=1.0)
g_skin = vp.fit_grade(frames, palette=teal_orange, strength=1.0, skin_protect=1.0)
moved = lambda g: np.abs(g.apply_srgb(skin) - skin).mean()  # noqa: E731
assert moved(g_skin) < 0.35 * moved(g_noskin), (moved(g_skin), moved(g_noskin))

# -- reference mode: the graded clip's mean colour moves toward the reference's
ref = np.zeros((32, 32, 3), np.uint8)
ref[:] = [40, 90, 160]
ref[::2] = [20, 50, 110]
gr = vp.fit_grade(frames, target_rgb=ref, strength=1.0)
tr = vp.expand_lut(gr.lut())
m_src = vp.srgb_to_oklab(frames.reshape(-1, 3) / 255.0).mean(0)
m_out = vp.srgb_to_oklab(vp.apply_table(frames[0], tr).reshape(-1, 3) / 255.0).mean(0)
m_ref = vp.srgb_to_oklab(ref.reshape(-1, 3) / 255.0).mean(0)
assert np.linalg.norm(m_out - m_ref) < 0.5 * np.linalg.norm(m_src - m_ref)
try:
    vp.fit_grade(frames)
    raise AssertionError("fit without palette or reference accepted")
except ValueError:
    pass

# -- grey clip + saturated palette: gains are clamped, no NaN / blow-up
grey = np.full((4, 16, 16, 3), 128, np.uint8)
lut = vp.fit_grade(grey, palette=vp.parse_palette("#ff0000, #00ff00"), strength=1.0).lut()
assert np.all(np.isfinite(lut)) and lut.min() >= 0 and lut.max() <= 1

# -- .cube export: header, 33^3 rows in 0..1, red fastest, parses back to the same LUT
cube = vp.cube_text(g.lut())
lines = cube.strip().splitlines()
assert "LUT_3D_SIZE 33" in lines and len([ln for ln in lines if ln[0].isdigit()]) == 33 ** 3
back = vp.parse_cube(cube)
assert np.allclose(back, g.lut(), atol=1e-6)
ident = vp.cube_text(g0.lut()).splitlines()
assert ident[4] == "0.000000 0.000000 0.000000" and ident[5] == "0.031250 0.000000 0.000000", ident[4:6]

# -- end to end: lavfi clip + tone -> graded mp4 (same size/frames, audio kept) + .cube next to it
with tempfile.TemporaryDirectory() as dd:
    src_mp4, out, cube_path, png = (os.path.join(dd, n) for n in ("src.mp4", "out.mp4", "out.cube", "ref.png"))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=96x80:r=12", "-f", "lavfi",
                    "-i", "sine=f=220:d=2", "-t", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src_mp4],
                   check=True)
    n = vp.grade_video(src_mp4, out, palette="#0b3c49, #e07a2f", strength=0.9, crf=30, cube_path=cube_path)
    assert n == 24, n
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height,nb_frames",
                            "-of", "json", out], capture_output=True, text=True, check=True).stdout
    streams = {s["codec_type"]: s for s in json.loads(probe)["streams"]}
    assert streams["video"]["width"] == 96 and streams["video"]["height"] == 80
    assert int(streams["video"]["nb_frames"]) == 24 and "audio" in streams
    with open(cube_path) as f:
        assert vp.parse_cube(f.read()).shape == (33, 33, 33, 3)
    # reference mode from a still, and strength 0 ~ the source (only the re-encode differs)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x305080:s=32x32", "-frames:v",
                    "1", png], check=True)
    assert vp.grade_video(src_mp4, out, reference_path=png, strength=1.0, crf=30) == 24
    assert vp.grade_video(src_mp4, out, palette="#ff0000", strength=0.0, crf=0) == 24

    def dec(p):
        r = subprocess.run(["ffmpeg", "-v", "error", "-i", p, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                           capture_output=True, check=True)
        return np.frombuffer(r.stdout, np.uint8).astype(int)

    # baseline = the same rgb24 -> yuv420p round trip without any grade (chroma subsampling is not the grade),
    # through the module's own decode / BT.709 encode filters
    plain = os.path.join(dd, "plain.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src_mp4, "-vf", vp.RGB_DECODE_VF, "-f", "rawvideo",
                    "-pix_fmt", "rgb24", os.path.join(dd, "src.rgb")], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "96x80", "-r", "12",
                    "-i", os.path.join(dd, "src.rgb"), "-vf", vp.BT709_ENCODE_VF, "-c:v", "libx264", "-crf", "0",
                    "-pix_fmt", "yuv420p", plain], check=True)
    tags = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries",
                                      "stream=color_space,color_primaries,color_transfer", "-of", "json", out],
                                     capture_output=True, text=True, check=True).stdout)["streams"][0]
    assert tags == {"color_space": "bt709", "color_primaries": "bt709", "color_transfer": "bt709"}, tags
    a, b = dec(plain), dec(out)
    assert a.shape == b.shape and np.abs(a - b).mean() < 0.5, np.abs(a - b).mean()

print("ok")

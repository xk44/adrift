"""CPU test for cj_grid_video (numpy + ffmpeg on PATH).  usage: python test_grid_video.py path/to/cj_grid_video.py"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

spec = importlib.util.spec_from_file_location("gv", sys.argv[1])
gv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gv)


def plan(frames=24, segs=((0, 12, 1, 1), (12, 24, 2, 2)), fx=None, w=64, h=64, still=False):
    out = []
    for f0, f1, r, c in segs:
        out.append({"f0": f0, "f1": f1, "rows": r, "cols": c, "gap": 2 if r * c > 1 else 0, "pulse": 0.1,
                    "tiles": [[i * 3, 1, 1, 1.2, .5, .5, i % 2, (i % len(fx)) if fx else -1, .8]
                              for i in range(r * c)]})
    return {"v": 1, "width": w, "height": h, "fps": 12, "frames": frames, "srcFrames": 12, "still": still,
            "bg": "#000000", "fx": fx or [], "segments": out}


# -- plan validation
p = gv.parse_plan(json.dumps(plan()))
assert p["frames"] == 24 and len(p["segments"]) == 2 and p["segments"][1]["tiles"].shape == (4, 9)
for bad, why in [
    ({**plan(), "v": 2}, "version"),
    ({**plan(), "width": 63}, "odd width"),
    ({**plan(), "frames": 25}, "segments must cover frames"),
    (plan(segs=((0, 12, 1, 1), (13, 24, 1, 1))), "gap between segments"),
    (plan(fx=[{"k": "nope"}]), "unknown effect kind"),
]:
    try:
        gv.parse_plan(bad)
    except ValueError:
        pass
    else:
        raise AssertionError(f"parse_plan accepted: {why}")
bad = plan()
bad["segments"][1]["tiles"][0][7] = 3
try:
    gv.parse_plan(bad)
    raise AssertionError("fx index past the table accepted")
except ValueError:
    pass
bad = plan()
bad["segments"][0]["tiles"] = bad["segments"][0]["tiles"] * 2
try:
    gv.parse_plan(bad)
    raise AssertionError("tile count != rows*cols accepted")
except ValueError:
    pass

# -- ping-pong loop: forward then backward, never jumps
assert [gv.pingpong(i, 4) for i in range(8)] == [0, 1, 2, 3, 2, 1, 0, 1]
assert gv.pingpong(5, 1) == 0

# -- grid edges: uniform gap, inside the frame
e = gv.edges(3, 100, 4)
assert e[0][0] >= 2 and e[-1][1] <= 98 and all(b > a for a, b in e)
assert gv.edges(2, 100, 0) == [(0, 50), (50, 100)]

# -- sampling: zoom 1 on a same-aspect tile reproduces the frame; mirror flips it
frame = np.random.default_rng(0).integers(0, 255, (1, 32, 32, 3), dtype=np.uint8)
pyr = gv.mip_pyramid(frame)
assert len(pyr) >= 2 and pyr[1].shape == (1, 16, 16, 3)
assert np.array_equal(gv.sample_tile(pyr, 0, 32, 32, 1.0, .5, .5), frame[0])
assert np.array_equal(gv.sample_tile(pyr, 0, 32, 32, 1.0, .5, .5, mirror=True), frame[0][:, ::-1])
small = gv.sample_tile(pyr, 0, 8, 8, 1.0, .5, .5)
assert small.shape == (8, 8, 3)
big = gv.sample_tile(pyr, 0, 64, 64, 1.5, .5, .5)  # enlarging -> bilinear path
assert big.shape == (64, 64, 3) and big.dtype == np.uint8

# -- effects keep shape/dtype and do what they say
t = frame[0]
for e in [{"k": "duotone", "a": "#000000", "b": "#ff0000"}, {"k": "posterize", "n": 3}, {"k": "invert"},
          {"k": "halftone", "ink": "#000000", "paper": "#ffffff"}, {"k": "mono", "contrast": 1.5},
          {"k": "solarize"}, {"k": "rgbsplit", "px": 8}, {"k": "swap"}]:
    o = gv.apply_effect(t, e)
    assert o.shape == t.shape and o.dtype == np.uint8, e
assert np.array_equal(gv.apply_effect(t, {"k": "invert"}), 255 - t)
duo = gv.apply_effect(t, {"k": "duotone", "a": "#000000", "b": "#ff0000"})
assert duo[..., 1:].max() == 0
assert set(np.unique(gv.apply_effect(t, {"k": "posterize", "n": 3}))) <= {0, 128, 255}
ht = gv.apply_effect(np.zeros((32, 32, 3), np.uint8), {"k": "halftone", "ink": "#000000", "paper": "#ffffff"})
assert ht.mean() < 40, "black input -> mostly ink"
assert gv.flash(t, 1.0).min() == 255 and np.array_equal(gv.flash(t, 0.0), t)

# -- end to end: lavfi clip + tone -> mp4 with the plan's length, size and an audio track
with tempfile.TemporaryDirectory() as d:
    src, aud, out = (os.path.join(d, n) for n in ("src.mp4", "tone.wav", "out.mp4"))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=96x80:r=12", "-t", "1",
                    "-pix_fmt", "yuv420p", src], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=220:d=3", aud], check=True)
    fx = [{"k": "halftone", "ink": "#111111", "paper": "#eeeeee"}, {"k": "duotone", "a": "#000000", "b": "#00ff88"}]
    n = gv.render_grid_video(src, aud, plan(fx=fx), out, crf=30, preset="ultrafast")
    assert n == 24, n
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                            "stream=codec_type,width,height,nb_frames,pix_fmt,color_space,color_primaries,color_transfer",
                            "-of", "json", out], capture_output=True, text=True, check=True).stdout
    streams = {s["codec_type"]: s for s in json.loads(probe)["streams"]}
    assert streams["video"]["width"] == 64 and streams["video"]["height"] == 64
    v = streams["video"]
    assert (v["pix_fmt"], v["color_space"], v["color_primaries"], v["color_transfer"]) == ("yuv420p",) + ("bt709",) * 3, v
    assert int(streams["video"]["nb_frames"]) == 24 and "audio" in streams
    png = os.path.join(d, "still.png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-frames:v", "1", png], check=True)
    assert gv.render_grid_video(png, None, plan(still=True), out, crf=30, preset="ultrafast") == 24

print("ok")

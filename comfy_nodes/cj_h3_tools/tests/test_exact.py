"""Exactness checks for cj_exact on synthetic clips, with a stub standing in for the model. CPU only.

Run: python tests/test_exact.py [workdir]
Pass conditions for each clip: equal frame count, equal PTS, samples with alpha 0 bit-identical in master mode, audio
packets byte-identical when copied, and the edit visible inside the mask."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

import av
import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("cj_exact", os.path.join(HERE, "..", "cj_exact.py"))
X = importlib.util.module_from_spec(spec)
spec.loader.exec_module(X)

BASE = ["ffmpeg", "-v", "error", "-nostdin", "-y"]


def src(size, rate, secs):
    return ["-f", "lavfi", "-i", f"testsrc2=s={size}:r={rate}:d={secs}", "-f", "lavfi", "-i", f"sine=f=330:d={secs}"]


CLIPS = {
    "fps24": src("640x360", 24, 2) + ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", "-c:a", "aac", "-shortest"],
    "fps30": src("640x360", 30, 2) + ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", "-c:a", "aac", "-shortest"],
    "fps60": src("640x360", 60, 2) + ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", "-c:a", "aac", "-shortest"],
    "ntsc": src("640x360", "30000/1001", 2) + ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", "-c:a", "aac", "-shortest"],
    "bit10": src("640x360", 24, 2) + ["-c:v", "libx264", "-pix_fmt", "yuv420p10le", "-crf", "12", "-c:a", "aac", "-shortest"],
    "y444": src("640x360", 24, 2) + ["-c:v", "libx264", "-pix_fmt", "yuv444p", "-crf", "12", "-c:a", "aac", "-shortest"],
    "y422": src("640x360", 24, 2) + ["-c:v", "libx264", "-pix_fmt", "yuv422p", "-crf", "12", "-c:a", "aac", "-shortest"],
    "tagged709": src("1280x720", 24, 1) + ["-vf", "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
                                           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", "-c:a", "aac", "-shortest"],
    "fullrange": src("640x360", 24, 1) + ["-vf", "scale=out_range=full,format=yuvj420p", "-c:v", "libx264", "-crf", "12",
                                          "-c:a", "aac", "-shortest"],
    "vfr": ["-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=2", "-vf", "setpts='N/24/TB+if(gte(N,24),0.25/TB,0)+if(gte(N,36),0.1/TB,0)'",
            "-fps_mode", "passthrough", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12"],
    "noaudio": ["-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12"],
    "pcm": src("640x360", 24, 1) + ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12", "-c:a", "pcm_s16le", "-shortest"],
}
EXT = {"pcm": ".mov"}


def make(name, d):
    path = os.path.join(d, name + EXT.get(name, ".mp4"))
    subprocess.run(BASE + CLIPS[name] + [path], check=True)
    return path


def make_rotated(d):
    base = make("fps24", d)
    out = os.path.join(d, "rot90.mp4")
    subprocess.run(BASE + ["-display_rotation", "90", "-i", base, "-c", "copy", out], check=True)
    return out


def scan(path):
    out = {"pts": [], "tb": None}
    with av.open(path) as c:
        v = c.streams.video[0]
        out["tb"] = v.time_base
        for f in c.decode(v):
            out["pts"].append(float(f.pts * f.time_base))
    return out


def audio_bytes(path):
    with av.open(path) as c:
        if not c.streams.audio:
            return None
        a = c.streams.audio[0]
        return b"".join(bytes(p) for p in c.demux(a) if p.size)


def stub(frames, count):
    """A moving box in the mask, painted a flat colour, plus a global brightness shift the colour match must remove
    and VAE-style blur outside the mask that must not reach the output."""
    T, h, w = len(frames), frames.shape[1], frames.shape[2]
    raw = np.zeros((T, h, w), bool)
    gen = np.empty_like(frames)
    for i in range(T):
        x = int(w * .2 + (w * .4) * min(i, count - 1) / max(count - 1, 1))
        y0, y1, x0, x1 = int(h * .3), int(h * .7), x, x + int(w * .2)
        raw[i, y0:y1, x0:x1] = True
        g = cv2.GaussianBlur(frames[i], (0, 0), 1.5).astype(np.int16) + 8
        g[y0:y1, x0:x1] = (200, 40, 160)
        gen[i] = np.clip(g, 0, 255).astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * 40 + 1, 2 * 40 + 1))
    exp = np.stack([cv2.dilate(m.astype(np.uint8), k) for m in raw]).astype(bool)
    return gen, raw, exp


def check(name, path, d, duration=0.0, expect_copy=True):
    frames, (w, h), count, fps, audio, native = X.prepare_exact(path, "480", duration)
    assert (len(frames) - 5) % 17 == 0 and len(frames) >= count, (len(frames), count)
    assert w % 32 == 0 and h % 32 == 0
    assert w * h <= X.PIXEL_BUDGETS["480"]
    gen, raw, exp = stub(frames, count)
    alphas, written = {}, {}

    def on_frame(i, a, planes, pts):
        alphas[i] = a > 0
        written[i] = [p.copy() for p in planes]

    out = os.path.join(d, name + "_master.mp4")
    stats = X.composite_exact(path, lambda i: gen[i], raw, exp, out, count, master=True, on_frame=on_frame)
    assert stats["frames"] == count

    a, b = scan(path), scan(out)
    limit = a["pts"][:count]
    assert len(b["pts"]) == count, f"frame count {len(b['pts'])} vs {count}"
    assert np.allclose(limit, b["pts"], atol=1e-3), f"pts differ, worst {np.abs(np.array(limit) - np.array(b['pts'])).max()}"

    # Compare the file as decoded, not what we handed the encoder.
    outside_diff, inside_changed, total_out = 0, 0, 0
    srcs = list(X.iter_frames(path, count))
    outs = list(X.iter_frames(out))
    assert len(outs) == count
    for i, ((ds, *_rest), (do, *_o)) in enumerate(zip(srcs, outs)):
        al = alphas[i]
        assert ds.planes[0].shape == do.planes[0].shape, (ds.planes[0].shape, do.planes[0].shape)
        total_out += int((~al).sum())
        outside_diff += int((ds.planes[0][~al] != do.planes[0][~al]).sum())
        inside_changed += int((ds.planes[0][al] != do.planes[0][al]).sum())
        ch, cw = ds.planes[1].shape
        ac = al if (ch, cw) == al.shape else cv2.resize(al.astype(np.float32), (cw, ch), interpolation=cv2.INTER_AREA) > 0
        for p in (1, 2):
            outside_diff += int((ds.planes[p][~ac] != do.planes[p][~ac]).sum())
    assert outside_diff == 0, f"{outside_diff} samples changed outside the edit"
    assert inside_changed > 0, "edit not visible"
    assert total_out > 0

    if expect_copy and duration == 0:
        src_a, out_a = audio_bytes(path), audio_bytes(out)
        assert src_a == out_a, f"audio differs: {None if src_a is None else len(src_a)} vs {None if out_a is None else len(out_a)}"

    delivery = os.path.join(d, name + "_delivery.mp4")
    X.composite_exact(path, lambda i: gen[i], raw, exp, delivery, count, crf=14)
    psnr = []
    for i, (ds, do) in enumerate(zip(srcs, X.iter_frames(delivery))):
        al = alphas[i]
        e = (ds[0].planes[0][~al].astype(np.float64) - do[0].planes[0][~al].astype(np.float64)) ** 2
        top = 2 ** ds[3][2] - 1
        psnr.append(10 * np.log10(top * top / max(e.mean(), 1e-9)))
    return {"clip": name, "frames": count, "fps": round(fps, 3), "model": f"{w}x{h}", "len": len(frames), "native": native,
            "offset": round(stats["colour_offset_max"], 4), "delivery_psnr_outside": round(float(np.mean(psnr)), 1),
            "audio": None if audio is None else list(audio["waveform"].shape)}


def check_rotation(d):
    """Our upright frame must match what ffmpeg's own autorotate shows, for every rotation."""
    base = os.path.join(d, "fps24.mp4")
    for angle in (90, 180, 270):
        path = os.path.join(d, f"rot{angle}_probe.mp4")
        subprocess.run(BASE + ["-display_rotation", str(angle), "-i", base, "-c", "copy", path], check=True)
        d0, _, _, fmt, _, f = next(X.iter_frames(path))
        ours = d0.rgb(X.Colour(f, fmt, d0.w, d0.h))
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                             check=True, capture_output=True).stdout
        theirs = np.frombuffer(raw, np.uint8).reshape(d0.h, d0.w, 3).astype(np.float32) / 255
        err = ((ours - theirs) ** 2).mean()
        psnr = 10 * np.log10(1 / max(err, 1e-9))
        assert psnr > 25, f"rotation {angle}: only {psnr:.1f} dB against ffmpeg"


def check_detects_lossy(d):
    """A delivery encode must differ somewhere outside the edit, or the master check proves nothing."""
    path = os.path.join(d, "fps24.mp4")
    frames, _, count, _, _, _ = X.prepare_exact(path, "480")
    gen, raw, exp = stub(frames, count)
    alphas = {}
    out = os.path.join(d, "mutation.mp4")
    X.composite_exact(path, lambda i: gen[i], raw, exp, out, count, crf=30,
                      on_frame=lambda i, a, p, t: alphas.__setitem__(i, a > 0))
    diff = 0
    for i, (a, b) in enumerate(zip(X.iter_frames(path, count), X.iter_frames(out))):
        diff += int((a[0].planes[0][~alphas[i]] != b[0].planes[0][~alphas[i]]).sum())
    assert diff > 0, "lossy encode looked identical: the identity check can't fail"



def test_edge_ramp():
    """A change that reaches the edge of the mask must fade out before it, not stop at a hard line."""
    h, w = 120, 160
    src_g = np.full((h, w, 3), 80, np.uint8)
    gen = np.full((h, w, 3), 200, np.uint8)
    allowed = np.zeros((h, w), bool)
    allowed[20:100, 30:130] = True
    subj = np.zeros((h, w), bool)
    subj[50:70, 70:90] = True
    hard = X.alpha_at_gen(src_g, gen, subj, allowed, 6.0, 8, 6)
    soft = X.alpha_at_gen(src_g, gen, subj, allowed, 6.0, 8, 6, edge_ramp=16)
    assert hard[~allowed].max() == 0 and soft[~allowed].max() == 0, "alpha left the mask"
    row = soft[60]
    assert row[30] < .02 and row[129] < .02, f"edge not faded: {row[30]} {row[129]}"
    assert np.abs(np.diff(row)).max() < .2, f"jump inside the ramp: {np.abs(np.diff(row)).max()}"
    assert hard[60, 31] > .5, "test does not reach the edge without the ramp"
    assert soft[60, 80] > .99, "subject faded"


def test_ref_on_scene():
    """The photo's background is gone, the subject stays, and the scene's own subject is painted out."""
    ref = np.full((90, 60, 3), 250, np.uint8)
    ref[30:60, 20:40] = (200, 120, 20)
    m = np.zeros((90, 60), np.float32)
    m[30:60, 20:40] = 1
    scene = np.full((120, 200, 3), 40, np.uint8)
    scene[40:80, 80:120] = (255, 255, 0)
    sm = np.zeros((120, 200), np.float32)
    sm[40:80, 80:120] = 1
    out = X.ref_on_scene(ref, scene, m, sm)
    assert out.shape == ref.shape
    assert out[5, 5].max() < 70, f"photo background left: {out[5, 5]}"
    assert np.abs(out[45, 30].astype(int) - (200, 120, 20)).max() < 3, f"subject changed: {out[45, 30]}"
    assert out[10, 30, 0] < 70, f"scene subject not painted out: {out[10, 30]}"


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="cj-exact-test-")
    os.makedirs(d, exist_ok=True)
    fails = 0
    cases = [(n, lambda n=n: make(n, d), {"expect_copy": n != "pcm"}) for n in CLIPS]
    cases.append(("rot90", lambda: make_rotated(d), {}))
    for name, build, kw in cases:
        try:
            print(json.dumps(check(name, build(), d, **kw)), flush=True)
        except Exception as e:
            fails += 1
            print(f"FAIL {name}: {type(e).__name__}: {e}", flush=True)
    try:
        check_rotation(d)
        print("rotation matches ffmpeg", flush=True)
    except Exception as e:
        fails += 1
        print(f"FAIL rotation: {type(e).__name__}: {e}", flush=True)
    try:
        test_edge_ramp()
        print("edge ramp fades the change out inside the mask", flush=True)
    except Exception as e:
        fails += 1
        print(f"FAIL edge ramp: {type(e).__name__}: {e}", flush=True)
    try:
        test_ref_on_scene()
        print("reference goes on the scene without its background", flush=True)
    except Exception as e:
        fails += 1
        print(f"FAIL ref on scene: {type(e).__name__}: {e}", flush=True)
    try:
        check_detects_lossy(d)
        print("identity check catches a lossy encode", flush=True)
    except Exception as e:
        fails += 1
        print(f"FAIL mutation: {type(e).__name__}: {e}", flush=True)
    try:
        path = os.path.join(d, "fps30.mp4")
        r = check("trim1s", path, d, duration=1.0)
        assert r["frames"] == 30, r
        out = os.path.join(d, "trim1s_master.mp4")
        with av.open(out) as c:
            dur = float(c.duration / av.time_base)
        assert dur < 1.15, f"trimmed output lasts {dur}"
        print(json.dumps(r), flush=True)
    except Exception as e:
        fails += 1
        print(f"FAIL trim1s: {type(e).__name__}: {e}", flush=True)
    print("ALL PASS" if not fails else f"{fails} FAILED")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

"""Plain-python tests for train_helpers (pytest or `python3 tests/test_train_helpers.py`)."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import train_helpers as th  # noqa: E402


def _raises(fn, *a, **k):
    try:
        fn(*a, **k)
    except ValueError:
        return True
    raise AssertionError(f"{fn.__name__}{a} did not raise")


def test_sanitize_name():
    assert th.sanitize_name("  my lora ") == "my_lora"
    assert th.sanitize_name("Rhodes-v2") == "Rhodes-v2"
    for bad in ("", "../x", "a/b", "-lead", "x" * 65, "na.me", "é"):
        _raises(th.sanitize_name, bad)


def test_safe_join():
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(os.path.join(root, "sa3_train", "a"))
        assert th.safe_join(root, "sa3_train/a") == os.path.realpath(os.path.join(root, "sa3_train", "a"))
        assert th.safe_join(root, "sa3_train\\a/").endswith(os.path.join("sa3_train", "a"))
        for bad in ("", "/etc", "../x", "sa3_train/../../x", "a/./b", ".", "a//b"):
            _raises(th.safe_join, root, bad)
        outside = tempfile.mkdtemp()
        try:
            os.symlink(outside, os.path.join(root, "link"))
            _raises(th.safe_join, root, "link")
        finally:
            os.rmdir(outside)


def test_captions():
    assert th.parse_captions("") == {}
    assert th.parse_captions('{"a.wav": "warm pad", "b.wav": null}') == {"a.wav": "warm pad", "b.wav": ""}
    _raises(th.parse_captions, "[1]")
    _raises(th.parse_captions, "{bad")
    assert th.caption_from_filename("03_Warm-Rhodes_loop.wav") == "warm rhodes loop"
    assert th.caption_from_filename("kickDrum.mp3") == "kick drum"
    assert th.caption_from_filename("___.wav") == "audio clip"
    assert th.caption_for("x_y.wav", {"x_y.wav": "  dusty   vinyl  "}) == "dusty vinyl"
    assert th.caption_for("x_y.wav", {"x_y.wav": "   "}) == "x y"


def test_dataset_files():
    with tempfile.TemporaryDirectory() as root:
        for f in ("b.wav", "a.flac", "notes.txt", "c.m4a", "d.MP3"):
            open(os.path.join(root, f), "wb").write(b"x")
        assert th.list_clips(root) == ["a.flac", "b.wav", "d.MP3"]
        assert th.list_clips(root, {"b.wav": "x"}) == ["b.wav"]
        # captions naming nothing that exists -> fall back to every clip
        assert th.list_clips(root, {"zzz.wav": "x"}) == ["a.flac", "b.wav", "d.MP3"]
        out = os.path.join(root, "work", "data")
        pairs = th.write_dataset(root, ["a.flac", "b.wav"], {"b.wav": "snare"}, out)
        assert pairs == [("a.flac", "a"), ("b.wav", "snare")]
        assert sorted(os.listdir(out)) == ["clip_000.flac", "clip_000.txt", "clip_001.txt", "clip_001.wav"]
        assert open(os.path.join(out, "clip_001.txt")).read() == "snare\n"


def test_validate():
    ok = dict(base="medium-base", adapter_type="lora", rank=16, alpha=0.0, steps=500,
              lr=1e-4, batch_size=1, duration=30.0, n_clips=5)
    th.validate_params(**ok)
    for k, v in (("base", "medium"), ("adapter_type", "bora"), ("rank", 0), ("alpha", -1),
                 ("steps", 5), ("lr", 0.0), ("lr", 0.5), ("lr", float("nan")), ("batch_size", 0),
                 ("duration", 500.0), ("n_clips", 4), ("n_clips", 201)):
        _raises(th.validate_params, **{**ok, k: v})
    _raises(th.validate_params, **{**ok, "batch_size": 6})


def test_args():
    py = "/sa3/.venv/bin/python"
    pre = th.preencode_args(py, "/sa3", "medium-base", "/w/data", "/w/enc")
    assert pre[:2] == [py, "/sa3/scripts/pre_encode_dataset.py"]
    assert pre[pre.index("--model") + 1] == "same-l"
    assert th.preencode_args(py, "/sa3", "small-sfx-base", "d", "e")[3] == "same-s"
    a = th.train_args(py, "/n/entry.py", "/sa3", base="medium-base", enc_dir="/w/enc", save_dir="/w/ck",
                      final_path="/w/f.safetensors", name="x", adapter_type="dora-rows", rank=32,
                      alpha=0.0, steps=1000, lr=5e-5, batch_size=2, duration=30, seed=7)
    assert a[:2] == [py, "/n/entry.py"] and a[a.index("--") + 1] == "--model"
    v = lambda flag: a[a.index(flag) + 1]  # noqa: E731
    assert v("--logger") == "csv" and v("--encoded_dir") == "/w/enc"
    assert v("--adapter_type") == "dora-rows" and v("--rank") == "32" and v("--lr") == "5e-05"
    assert v("--checkpoint_every") == "250" and v("--demo_every") == "1001"
    assert "--lora_alpha" not in a and "--data_dir" not in a
    a2 = th.train_args(py, "e", "/sa3", base="medium-base", enc_dir="e", save_dir="s", final_path="f",
                       name="x", adapter_type="lora", rank=8, alpha=16.0, steps=100, lr=1e-4,
                       batch_size=1, duration=10, seed=1)
    assert a2[a2.index("--lora_alpha") + 1] == "16.0"
    assert th.checkpoint_every(100) == 50
    assert all(isinstance(x, str) for x in a + a2 + pre)
    assert th.convert_args(py, "c.py", "medium-base", "i", "o") == [py, "c.py", "i", "o", "--model", "medium-base"]


def test_env():
    env = th.child_env({"PYTHONPATH": "/x", "VIRTUAL_ENV": "/comfy/venv", "HOME": "/h"}, "/shims", "/sa3")
    assert env["PYTHONPATH"].split(os.pathsep) == ["/shims", "/sa3", "/x"]
    assert "VIRTUAL_ENV" not in env and env["HOME"] == "/h" and env["PYTHONUNBUFFERED"] == "1"


def test_child_env_sa3_hf_home():
    env = th.child_env({"HF_HOME": "/comfy-cache", "CJ_SA3_HF_HOME": "/sa3-cache"}, "/s", "/a")
    assert env["HF_HOME"] == "/sa3-cache" and "CJ_SA3_HF_HOME" not in env
    env = th.child_env({"HF_HOME": "/comfy-cache"}, "/s", "/a")
    assert env["HF_HOME"] == "/comfy-cache"


def test_parse_line():
    assert th.parse_line("CJ_STEP 12 500 0.123400\n") == ("step", 12, 500, 0.1234)
    assert th.parse_line("CJ_STEP 3 500 nan") == ("step", 3, 500, None)
    assert th.parse_line("CJ_FINAL /w/x.safetensors\n") == ("final", "/w/x.safetensors")
    assert th.parse_line("Processing batch 4") == ("encode", 4)
    assert th.parse_line("Epoch 0: 10%") is None


def test_losses():
    assert th.summarize_losses([]) == {}
    s = th.summarize_losses([(i, 1.0 - i / 100) for i in range(1, 101)])
    assert s["steps"] == 100 and abs(s["min"] - 0.0) < 1e-9
    assert s["first"] > s["last"]
    txt = th.summary_text("audio/x.safetensors", s, 7, "medium-base", "lora", 16, 100)
    assert txt.startswith("Saved loras/audio/x.safetensors: 7 clips") and "loss" in txt
    assert "loss" not in th.summary_text("audio/x.safetensors", {}, 7, "medium-base", "lora", 16, 100)


def test_unique_path():
    with tempfile.TemporaryDirectory() as root:
        p, rel = th.unique_lora_path(root, "drums")
        assert rel == "audio/drums.safetensors" and p == os.path.join(root, "audio", "drums.safetensors")
        open(p, "wb").close()
        p2, rel2 = th.unique_lora_path(root, "drums")
        assert rel2 == "audio/drums_2.safetensors"


if __name__ == "__main__":
    n = 0
    for k, fn in sorted(globals().items()):
        if k.startswith("test_") and callable(fn):
            fn()
            n += 1
    print(f"{n} tests passed")

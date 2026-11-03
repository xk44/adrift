"""End-to-end plumbing test for CJSA3TrainAudioLoRA with stubbed ComfyUI modules
and fake trainer scripts (no torch, no GPU). Plain python3 or pytest."""
import importlib
import json
import os
import sys
import tempfile
import time
import types

PKG_PARENT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FAKE_PRE = """import argparse, os
ap = argparse.ArgumentParser(); ap.add_argument('--model'); ap.add_argument('--data_dir')
ap.add_argument('--output_path'); ap.add_argument('--batch_size'); a = ap.parse_args()
os.makedirs(a.output_path, exist_ok=True)
txt = sorted(f for f in os.listdir(a.data_dir) if f.endswith('.txt'))
for i, f in enumerate(txt):
    print('Processing batch', i, flush=True)
open(os.path.join(a.output_path, 'caps.txt'), 'w').write('|'.join(open(os.path.join(a.data_dir, f)).read().strip() for f in txt))
"""

FAKE_ENTRY = """import os, sys, time
argv = sys.argv; final = argv[argv.index('--final_out') + 1]
steps = int(argv[argv.index('--steps') + 1])
if os.environ.get('FAKE_SLOW'):
    print('CJ_STEP 1 %d 0.5' % steps, flush=True); time.sleep(60)
for s in range(1, steps + 1):
    print('CJ_STEP %d %d %f' % (s, steps, 1.0 / s), flush=True)
open(final, 'w').write('sa3')
print('CJ_FINAL ' + final, flush=True)
"""

FAKE_CONVERT = """import sys
src, dst = sys.argv[1], sys.argv[2]
assert sys.argv[sys.argv.index('--model') + 1] == 'medium-base'
open(dst, 'w').write('comfy:' + open(src).read())
"""


class Interrupted(Exception):
    pass


def _setup(tmp):
    state = {"interrupt": False, "unloaded": 0, "progress": []}
    mm = types.ModuleType("comfy.model_management")
    mm.processing_interrupted = lambda: state["interrupt"]

    def throw():
        if state["interrupt"]:
            state["interrupt"] = False
            raise Interrupted()
    mm.throw_exception_if_processing_interrupted = throw
    mm.unload_all_models = lambda: state.__setitem__("unloaded", state["unloaded"] + 1)
    mm.soft_empty_cache = lambda: None
    utils = types.ModuleType("comfy.utils")

    class PB:
        def __init__(self, total):
            self.total = total

        def update_absolute(self, v, total=None):
            state["progress"].append((v, total))
    utils.ProgressBar = PB
    comfy = types.ModuleType("comfy")
    comfy.model_management, comfy.utils = mm, utils
    fp = types.ModuleType("folder_paths")
    for d in ("input", "user", "loras", "sa3/scripts", "sa3/.venv/bin", "fake"):
        os.makedirs(os.path.join(tmp, d), exist_ok=True)
    fp.get_input_directory = lambda: os.path.join(tmp, "input")
    fp.get_user_directory = lambda: os.path.join(tmp, "user")
    fp.get_folder_paths = lambda k: [os.path.join(tmp, "loras")]
    sys.modules.update({"comfy": comfy, "comfy.model_management": mm, "comfy.utils": utils, "folder_paths": fp})
    os.symlink(sys.executable, os.path.join(tmp, "sa3/.venv/bin/python"))
    open(os.path.join(tmp, "sa3/scripts/pre_encode_dataset.py"), "w").write(FAKE_PRE)
    open(os.path.join(tmp, "fake/entry.py"), "w").write(FAKE_ENTRY)
    open(os.path.join(tmp, "fake/convert.py"), "w").write(FAKE_CONVERT)
    clips = os.path.join(tmp, "input", "sa3_train", "drums")
    os.makedirs(clips)
    for i in range(6):
        open(os.path.join(clips, f"{i:02d}_Kick_Loop{i}.wav"), "wb").write(b"RIFF")
    if PKG_PARENT not in sys.path:
        sys.path.insert(0, PKG_PARENT)
    for m in [m for m in sys.modules if m.startswith("cj_sa3_audio")]:
        del sys.modules[m]
    tn = importlib.import_module("cj_sa3_audio.train_node")
    tn.ENTRY = os.path.join(tmp, "fake/entry.py")
    tn.CONVERTER = os.path.join(tmp, "fake/convert.py")
    return tn, state


def _kw(tmp, **over):
    kw = dict(name="drums", dataset="sa3_train/drums",
              captions=json.dumps({"00_Kick_Loop0.wav": "punchy kick"}),
              base="medium-base", adapter_type="lora", rank=16, alpha=0.0, steps=20, lr=1e-4,
              batch_size=1, duration=30.0, seed=1, sa3_dir=os.path.join(tmp, "sa3"))
    kw.update(over)
    return kw


def test_train_end_to_end():
    with tempfile.TemporaryDirectory() as tmp:
        tn, state = _setup(tmp)
        node = tn.CJSA3TrainAudioLoRA()
        # captions name one clip -> only that clip... so give all names
        caps = {f"{i:02d}_Kick_Loop{i}.wav": "" for i in range(6)}
        caps["00_Kick_Loop0.wav"] = "punchy kick"
        out = node.train(**_kw(tmp, captions=json.dumps(caps)))
        rel, summary = out["result"]
        assert rel == "audio/drums.safetensors", rel
        assert open(os.path.join(tmp, "loras", rel)).read() == "comfy:sa3"
        assert state["unloaded"] == 1
        assert state["progress"][-1] == (20, 20)
        assert "6 clips" in summary and "loss" in summary
        assert out["ui"]["cj_sa3_lora"][0]["lora"] == rel
        work = os.path.join(tmp, "user", "cj_sa3_train")
        run = os.path.join(work, os.listdir(work)[0])
        caps_written = json.load(open(os.path.join(run, "captions.json")))
        assert caps_written["00_Kick_Loop0.wav"] == "punchy kick"
        assert caps_written["01_Kick_Loop1.wav"] == "kick loop1"
        assert not os.path.exists(os.path.join(run, "encoded"))  # derived latents cleaned
        # second run with the same name does not overwrite
        rel2 = node.train(**_kw(tmp, captions=json.dumps(caps)))["result"][0]
        assert rel2 == "audio/drums_2.safetensors"


def test_rejects_bad_input():
    with tempfile.TemporaryDirectory() as tmp:
        tn, _ = _setup(tmp)
        node = tn.CJSA3TrainAudioLoRA()
        for over in ({"dataset": "../user"}, {"name": "../x"}, {"dataset": "sa3_train/none"},
                     {"base": "medium"}, {"sa3_dir": os.path.join(tmp, "nope")}):
            try:
                node.train(**_kw(tmp, **over))
            except (ValueError, RuntimeError):
                continue
            raise AssertionError(f"accepted {over}")


def test_interrupt_kills_child():
    with tempfile.TemporaryDirectory() as tmp:
        tn, state = _setup(tmp)
        os.environ["FAKE_SLOW"] = "1"
        try:
            def flip():
                time.sleep(1.5)
                state["interrupt"] = True
            import threading
            threading.Thread(target=flip, daemon=True).start()
            t0 = time.time()
            try:
                tn.CJSA3TrainAudioLoRA().train(**_kw(tmp, captions="{}"))
            except Interrupted:
                pass
            else:
                raise AssertionError("not interrupted")
            assert time.time() - t0 < 30
            assert not os.path.exists(os.path.join(tmp, "loras", "audio", "drums.safetensors"))
        finally:
            os.environ.pop("FAKE_SLOW", None)


if __name__ == "__main__":
    n = 0
    for k, fn in sorted(globals().items()):
        if k.startswith("test_") and callable(fn):
            fn()
            n += 1
    print(f"{n} tests passed")

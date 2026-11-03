"""CJSA3TrainAudioLoRA: train a Stable Audio 3 LoRA from clips in ComfyUI's
input folder and drop the ComfyUI-format result into models/loras/audio/.

The trainer is Stability's stable-audio-3 repo with its own venv (default
~/projects/stable-audio-3, or env CJ_SA3_DIR). Three child processes, each an
argument list (never a shell): pre_encode_dataset.py -> tools/sa3_train_entry.py
(train_lora.py + progress lines) -> tools/sa3_lora_to_comfy.py. ComfyUI's
models are unloaded first so the trainer gets the whole GPU; Stop/Cancel in
ComfyUI kills the running child.
"""
import json
import logging
import os
import queue
import shutil
import signal
import subprocess
import threading
import time

import comfy.model_management as mm
import comfy.utils
import folder_paths

from . import train_helpers as th

_log = logging.getLogger("cj_sa3_audio.train")
_HERE = os.path.dirname(os.path.abspath(__file__))
SHIMS = os.path.join(_HERE, "trainer_shims")
ENTRY = os.path.join(_HERE, "tools", "sa3_train_entry.py")
CONVERTER = os.path.join(_HERE, "tools", "sa3_lora_to_comfy.py")


def default_sa3_dir():
    return os.environ.get("CJ_SA3_DIR") or os.path.expanduser("~/projects/stable-audio-3")


def _kill(proc):
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, AttributeError):
        proc.terminate()
    try:
        proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, AttributeError):
            proc.kill()
        proc.wait()


def _run(args, env, cwd, log_fh, tag, on_event=None):
    """Run one child, mirror its output to the ComfyUI log + log file, honour interrupt."""
    _log.info("[%s] %s", tag, " ".join(args))
    proc = subprocess.Popen(
        args, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, bufsize=1, errors="replace",
        start_new_session=True,
    )
    lines = queue.Queue()

    def pump():
        for line in proc.stdout:
            lines.put(line)
        lines.put(None)

    threading.Thread(target=pump, daemon=True).start()
    tail = []
    try:
        while True:
            if mm.processing_interrupted():
                _kill(proc)
                mm.throw_exception_if_processing_interrupted()
            try:
                line = lines.get(timeout=0.5)
            except queue.Empty:
                continue
            if line is None:
                break
            log_fh.write(line)
            ev = th.parse_line(line)
            if ev is None or ev[0] != "step":
                _log.info("[%s] %s", tag, line.rstrip())
            tail = (tail + [line.rstrip()])[-25:]
            if ev is not None and on_event:
                on_event(ev)
    except BaseException:
        _kill(proc)
        raise
    finally:
        log_fh.flush()
    code = proc.wait()
    if code != 0:
        raise RuntimeError(f"SA3 {tag} failed (exit {code}). Last output:\n" + "\n".join(tail[-12:]))


class CJSA3TrainAudioLoRA:
    CATEGORY = "adrift/audio"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("lora_name", "summary")
    FUNCTION = "train"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "Train a Stable Audio 3 LoRA from 5+ audio clips in input/<dataset>/. Captions: JSON "
        "{filename: caption}; missing ones come from the filename. Runs the stable-audio-3 "
        "trainer in its own venv, then saves loras/audio/<name>.safetensors."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "name": ("STRING", {"default": "my_audio_lora"}),
                "dataset": ("STRING", {"default": "sa3_train/my_audio_lora",
                                       "tooltip": "Subfolder of the ComfyUI input folder with the clips."}),
                "captions": ("STRING", {"default": "{}", "multiline": True}),
                "base": (list(th.BASES), {"default": "medium-base"}),
                "adapter_type": (list(th.ADAPTERS), {"default": "lora"}),
                "rank": ("INT", {"default": 16, "min": 1, "max": 256}),
                "alpha": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1024.0, "step": 1.0,
                                    "tooltip": "0 = same as rank."}),
                "steps": ("INT", {"default": 1500, "min": 10, "max": 50000}),
                "lr": ("FLOAT", {"default": 1e-4, "min": 1e-7, "max": 1e-2, "step": 1e-6, "round": False}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 16}),
                "duration": ("FLOAT", {"default": 30.0, "min": 1.0, "max": 380.0, "step": 1.0,
                                       "tooltip": "Seconds of each clip seen per step (random crop)."}),
                "seed": ("INT", {"default": 42, "min": 0, "max": 2**31 - 1}),
            },
            "optional": {
                "sa3_dir": ("STRING", {"default": "",
                                       "tooltip": "stable-audio-3 checkout with .venv. Empty = $CJ_SA3_DIR or ~/projects/stable-audio-3."}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **_kw):
        return float("nan")  # never serve a cached "training"

    def train(self, name, dataset, captions, base, adapter_type, rank, alpha, steps, lr,
              batch_size, duration, seed, sa3_dir=""):
        name = th.sanitize_name(name)
        src = th.safe_join(folder_paths.get_input_directory(), dataset)
        if not os.path.isdir(src):
            raise ValueError(f"dataset folder input/{dataset} not found")
        caps = th.parse_captions(captions)
        files = th.list_clips(src, caps)
        th.validate_params(base, adapter_type, rank, alpha, steps, lr, batch_size, duration, len(files))

        sa3 = os.path.abspath(os.path.expanduser((sa3_dir or "").strip() or default_sa3_dir()))
        python = th.sa3_python(sa3)
        if not os.path.isfile(python):
            raise RuntimeError(f"stable-audio-3 venv not found at {python}; set CJ_SA3_DIR or sa3_dir")

        work = os.path.join(folder_paths.get_user_directory(), "cj_sa3_train",
                            f"{name}_{time.strftime('%Y%m%d-%H%M%S')}")
        data_dir, enc_dir, ckpt_dir = (os.path.join(work, d) for d in ("data", "encoded", "ckpt"))
        final_sa3 = os.path.join(work, f"{name}_sa3.safetensors")
        os.makedirs(work, exist_ok=True)
        pairs = th.write_dataset(src, files, caps, data_dir)
        with open(os.path.join(work, "captions.json"), "w", encoding="utf-8") as fh:
            json.dump(dict(pairs), fh, indent=1)

        # Free the GPU for the trainer process.
        mm.unload_all_models()
        mm.soft_empty_cache()

        env = th.child_env(os.environ, SHIMS, sa3)
        pbar = comfy.utils.ProgressBar(int(steps))
        losses = []
        final = {}

        def on_event(ev):
            if ev[0] == "step":
                _, step, total, loss = ev
                losses.append((step, loss))
                pbar.update_absolute(min(step, int(steps)), int(steps))
                if step % 50 == 0 or step == total:
                    _log.info("[train] step %d/%d loss %s", step, total, loss)
            elif ev[0] == "final":
                final["path"] = ev[1]

        with open(os.path.join(work, "train.log"), "a", encoding="utf-8") as log_fh:
            _run(th.preencode_args(python, sa3, base, data_dir, enc_dir), env, sa3, log_fh, "pre-encode")
            _run(th.train_args(python, ENTRY, sa3, base=base, enc_dir=enc_dir, save_dir=ckpt_dir,
                               final_path=final_sa3, name=name, adapter_type=adapter_type, rank=rank,
                               alpha=alpha, steps=steps, lr=lr, batch_size=batch_size,
                               duration=duration, seed=seed),
                 env, sa3, log_fh, "train", on_event)
            if not os.path.isfile(final.get("path", final_sa3)):
                raise RuntimeError("SA3 training finished without writing a LoRA (see train.log in " + work + ")")
            out_abs, out_rel = th.unique_lora_path(folder_paths.get_folder_paths("loras")[0], name)
            tmp = out_abs + ".part"
            _run(th.convert_args(python, CONVERTER, base, final_sa3, tmp), env, sa3, log_fh, "convert")
            os.replace(tmp, out_abs)

        # Latents and clip copies are derived and large; keep logs, captions, step checkpoints
        # (LoRA-only, small) and the SA3-format LoRA for resuming.
        shutil.rmtree(enc_dir, ignore_errors=True)
        shutil.rmtree(data_dir, ignore_errors=True)
        info = th.summarize_losses(losses)
        summary = th.summary_text(out_rel, info, len(files), base, adapter_type, rank, steps)
        _log.info("[train] %s", summary)
        _log.info("[train] work dir %s", work)
        report = {"lora": out_rel, "base": base, "clips": len(files), "loss": info}
        return {"ui": {"text": [summary], "cj_sa3_lora": [report]}, "result": (out_rel, summary)}


NODE_CLASS_MAPPINGS = {"CJSA3TrainAudioLoRA": CJSA3TrainAudioLoRA}
NODE_DISPLAY_NAME_MAPPINGS = {"CJSA3TrainAudioLoRA": "Train Audio LoRA (Stable Audio 3)"}

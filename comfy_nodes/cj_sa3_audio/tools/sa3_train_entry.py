"""Run stable-audio-3's scripts/train_lora.py with Adrift's progress protocol.

Runs in the stable-audio-3 venv (spawned by CJSA3TrainAudioLoRA):
  PYTHONPATH=<cj_sa3_audio>/trainer_shims:<sa3_dir> .venv/bin/python sa3_train_entry.py \
      --sa3_dir <sa3_dir> --final_out <final.safetensors> -- <train_lora.py args>

Adds to the stock trainer, without editing it:
  - one stdout line per optimizer step:  CJ_STEP <step> <max_steps> <loss>
  - the final LoRA exported as .safetensors (with its lora_config) on train end,
    then:                                 CJ_FINAL <path>
  - no tqdm bar (\\r spam in a log) and no in-training demo renders (they only
    feed wandb/comet, and cost minutes of GPU at step 1).
"""
import argparse
import os
import runpy
import sys

import torch  # noqa: F401  (must load before pytorch_lightning)
import pytorch_lightning as pl


class _Progress(pl.Callback):
    def __init__(self, final_out):
        self.final_out = final_out

    def on_train_batch_end(self, trainer, pl_module, outputs, batch, batch_idx):
        loss = outputs.get("loss") if isinstance(outputs, dict) else outputs
        try:
            val = float(loss.detach().float().item()) if loss is not None else float("nan")
        except Exception:
            val = float("nan")
        print(f"CJ_STEP {trainer.global_step} {trainer.max_steps} {val:.6f}", flush=True)

    def on_train_end(self, trainer, pl_module):
        if trainer.global_rank != 0:
            return
        os.makedirs(os.path.dirname(os.path.abspath(self.final_out)), exist_ok=True)
        pl_module.export_lora_safetensors(self.final_out)
        print(f"CJ_FINAL {self.final_out}", flush=True)


def main():
    if "--" not in sys.argv:
        raise SystemExit("usage: sa3_train_entry.py --sa3_dir D --final_out F -- <train_lora args>")
    cut = sys.argv.index("--")
    ap = argparse.ArgumentParser()
    ap.add_argument("--sa3_dir", required=True)
    ap.add_argument("--final_out", required=True)
    own = ap.parse_args(sys.argv[1:cut])
    rest = sys.argv[cut + 1:]

    progress = _Progress(own.final_out)
    base_trainer = pl.Trainer

    class Trainer(base_trainer):
        def __init__(self, *a, callbacks=None, **kw):
            cbs = [c for c in (callbacks or []) if type(c).__name__ != "DiffusionCondInpaintDemoCallback"]
            kw["enable_progress_bar"] = False
            super().__init__(*a, callbacks=cbs + [progress], **kw)

    pl.Trainer = Trainer  # train_lora.py looks it up at call time

    script = os.path.join(own.sa3_dir, "scripts", "train_lora.py")
    sys.argv = [script] + rest
    runpy.run_path(script, run_name="__main__")


if __name__ == "__main__":
    main()

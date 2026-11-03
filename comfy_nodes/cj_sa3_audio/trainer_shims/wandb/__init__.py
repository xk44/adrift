"""Offline stand-in for `wandb` so the Stable Audio 3 LoRA trainer imports
without the real package (which is heavy and phones home).

stable_audio_3/training/utils.py does a top-level `import wandb` but only
calls wandb.Audio / wandb.Image when the run uses a WandbLogger. Adrift runs
the trainer with --logger csv, so those paths never execute; if they ever do,
fail loudly instead of silently dropping data.
"""


def _unavailable(*_a, **_k):
    raise RuntimeError(
        "wandb is not installed (Adrift ships an offline stub); "
        "run the SA3 trainer with --logger csv"
    )


Audio = Image = Table = Object3D = init = log = _unavailable

"""Make a synthetic SA3 LoRA (random non-zero adapter weights) for converter
tests, saved exactly the way the SA3 trainer saves checkpoints.

  python make_test_lora.py out.safetensors --adapter dora-rows --rank 8
"""
import argparse
from functools import partial

import torch

from sa3_lora_to_comfy import build_base


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dst")
    ap.add_argument("--adapter", default="lora")
    ap.add_argument("--rank", type=int, default=8)
    ap.add_argument("--model", default="medium-base")
    ap.add_argument("--include", nargs="*", default=["transformer.layers.0.", "transformer.layers.23."])
    a = ap.parse_args()

    from stable_audio_3.models.lora.model import LoRAParametrization, add_lora
    from stable_audio_3.models.lora.utils import get_lora_state_dict, save_lora_safetensors

    torch.manual_seed(0)
    model, _ = build_base(a.model)
    cfg = {
        torch.nn.Linear: {"weight": partial(LoRAParametrization.from_linear, rank=a.rank, lora_alpha=a.rank, adapter_type=a.adapter, lora_index=0)},
        torch.nn.Conv1d: {"weight": partial(LoRAParametrization.from_conv1d, rank=a.rank, lora_alpha=a.rank, adapter_type=a.adapter, lora_index=0)},
    }
    add_lora(model.model, cfg, include=a.include)
    sd = get_lora_state_dict(model.model)
    for k, v in sd.items():
        if k.endswith("lora_B") or k.endswith("M_xs"):
            sd[k] = torch.randn_like(v) * 0.02
        elif "magnitude" in k:
            sd[k] = v * (1 + 0.05 * torch.randn_like(v))
    lcfg = {"rank": a.rank, "alpha": a.rank, "adapter_type": a.adapter, "dropout": 0.0,
            "include": a.include, "exclude": None}
    save_lora_safetensors(sd, lcfg, a.dst)
    print(f"wrote {a.dst}: {len(sd)} tensors, adapter {a.adapter}")


if __name__ == "__main__":
    main()

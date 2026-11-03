"""Convert a Stable Audio 3 LoRA (stable-audio-3 trainer output) into a
ComfyUI-loadable LoRA (diffusion_model.<module>.lora_up/lora_down/alpha).

The SA3 trainer stores adapters as torch parametrizations. Mapping (exact):
  lora / lora-xs      -> lora_up/lora_down (the trained rank-r factors, exact)
  dora-rows(-xs)      -> lora_up/lora_down + dora_scale [out,1..]: ComfyUI's
                         output-axis DoRA divides by ||W||, so we fold
                         m*||W||/||W+dW|| into the scale
  dora-cols(-xs) 2-D  -> lora_up/lora_down + dora_scale [1,in] (= magnitude)
  bora*, conv dora-cols -> <key>.diff (full-weight difference, larger file)
Verify with tools/verify_comfy_lora.py in the ComfyUI venv.

Run with the stable-audio-3 venv (needs its package importable):
  PYTHONPATH=<cj_sa3_audio>/trainer_shims .venv/bin/python sa3_lora_to_comfy.py \
      in_lora.safetensors out_comfy_lora.safetensors [--model medium-base]

Conditioner (T5Gemma / seconds) adapters have no ComfyUI LoRA target here and
are skipped with a warning.
"""
import argparse
import json
import sys

import torch
from safetensors.torch import load_file, save_file


def build_base(model_name):
    from stable_audio_3.factory import create_diffusion_cond_from_config
    from stable_audio_3.loading_utils import copy_state_dict
    from stable_audio_3.model_configs import base_models

    if model_name not in base_models:
        raise SystemExit(f"unknown base model {model_name!r}; have {list(base_models)}")
    cfg_path, ckpt = base_models[model_name].resolve()
    with open(cfg_path) as f:
        cfg = json.load(f)
    model = create_diffusion_cond_from_config(cfg)
    copy_state_dict(model, load_file(ckpt))
    return model.float().eval().requires_grad_(False), cfg


def lowrank(delta, energy, max_rank):
    """delta (out, in...) -> up (out, r), down (r, in...), rel_err."""
    shape = delta.shape
    m = delta.reshape(shape[0], -1).double()
    norm = m.norm()
    if norm == 0:
        return None
    u, s, vh = torch.linalg.svd(m, full_matrices=False)
    cum = torch.cumsum(s * s, 0) / (s * s).sum()
    r = int(torch.searchsorted(cum, torch.tensor(energy, dtype=cum.dtype)).item()) + 1
    r = max(1, min(r, max_rank, s.numel()))
    up = u[:, :r] * s[:r]
    down = vh[:r]
    err = ((up @ down) - m).norm() / norm
    return up.float(), down.reshape((r,) + tuple(shape[1:])).float(), float(err)


def factors(p, w0):
    """Rank-r (up, down) with up @ down == the adapter's direction delta.
    Read straight from the trained factors (no SVD of a differenced matrix)."""
    if getattr(p, "fan_in_fan_out", False) or p.swap((0, 1)) != (0, 1):
        raise SystemExit("fan_in_fan_out adapters are not supported")
    s = float(p.scaling) * float(p.lora_strength)
    if p.adapter_type.endswith("xs"):
        up = (p.U.double() @ p.M_xs.double()) * s
        down = p.V.double().T
    else:
        up = p.lora_B.double() * s
        down = p.lora_A.double()
    r = up.shape[1]
    return up.float().cpu(), down.reshape((r,) + tuple(w0.shape[1:])).float().cpu()


def convert(in_path, out_path, model_name, energy, max_rank, device, ref_path=None):
    from stable_audio_3.models.lora import load_and_apply_loras
    from stable_audio_3.models.lora.model import LoRAParametrization
    from stable_audio_3.models.lora.utils import load_lora_checkpoint

    _, lcfg = load_lora_checkpoint(in_path)
    model, cfg = build_base(model_name)
    model.to(device)
    load_and_apply_loras(model, [in_path], cfg.get("model_type", "diffusion_cond"))

    out, report, skipped, refs = {}, [], [], {}
    for root_name, root in (("model", model.model), ("conditioner", model.conditioner)):
        for name, mod in root.named_modules():
            plists = getattr(mod, "parametrizations", None)
            if plists is None or "weight" not in plists:
                continue
            plist = plists["weight"]
            lp = [p for p in plist if isinstance(p, LoRAParametrization)]
            if not lp:
                continue
            p = lp[0]
            with torch.no_grad():
                w0 = plist.original.float()
                merged = p(w0)
            if root_name != "model":
                if (merged - w0).abs().max() > 0:
                    skipped.append(f"{root_name}.{name}")
                continue
            # SA3 checkpoint key "model.model.<name>.weight" -> ComfyUI
            # diffusion_model.<name> (CheckpointLoader strips "model.model.")
            # model.model is SA3's DiT wrapper; its inner ".model." is not part
            # of ComfyUI's key (diffusion_model.transformer.layers...)
            cname = name[len("model."):] if name.startswith("model.") else name
            key = f"diffusion_model.{cname}"
            if len(refs) < 4:
                refs[cname] = merged.detach().cpu()
            t = p.adapter_type
            if t.startswith("bora") or (t.startswith("dora-cols") and w0.dim() > 2):
                # no ComfyUI equivalent: exact full-weight difference
                out[f"{key}.diff"] = (merged - w0).cpu().half().contiguous()
                report.append((name, "diff", 0.0))
                continue
            with torch.no_grad():
                up, down = factors(p, w0)      # exact rank-r factors of the delta
                core = p.lora_xs_forward if t.endswith("xs") else p.lora_forward
                d_ref = (core(w0) - w0).reshape(w0.shape[0], -1).double()
            if float(up.abs().max()) == 0.0:
                continue
            d_fac = up.double() @ down.reshape(down.shape[0], -1).double()
            # fp32 subtraction noise in d_ref bounds this check, not the factors
            err = float((d_fac - d_ref).norm() / d_ref.norm().clamp_min(1e-30))
            assert err < 1e-3, f"{name}: factor mismatch {err:.2e}"
            d_low = d_fac.float().reshape(w0.shape)
            out[f"{key}.lora_up.weight"] = up.half().contiguous()
            out[f"{key}.lora_down.weight"] = down.half().contiguous()
            out[f"{key}.alpha"] = torch.tensor(float(up.shape[1]))
            if t.startswith("dora"):
                with torch.no_grad():
                    W2 = w0.reshape(w0.shape[0], -1)
                    V = W2 + d_low.reshape(w0.shape[0], -1)
                    m = p.magnitude.float()
                    # ComfyUI patches in fp32 and adds finfo(fp32).eps to its norm
                    EPS32 = torch.finfo(torch.float32).eps
                    if p._norm_dim == 1:
                        # ComfyUI output-axis branch divides by ||W|| (not ||V||):
                        # s = m * ||W||_row / ||V||_row reproduces SA3 exactly
                        s = m * (W2.norm(dim=1) + EPS32) / (V.norm(dim=1) + 1e-12)
                        scale = s.reshape(w0.shape[0], *[1] * (w0.dim() - 1))
                    else:
                        # column branch normalizes by ||W+dW||_col like SA3
                        scale = (m * (V.norm(dim=0) + EPS32) / (V.norm(dim=0) + 1e-12)).reshape(1, -1)
                # fp32: the scale carries the whole magnitude, fp16 rounding shows
                out[f"{key}.dora_scale"] = scale.cpu().float().contiguous()
            report.append((name, up.shape[1], err))

    if not out:
        raise SystemExit("no non-zero diffusion-model adapter deltas found")
    meta = {
        "source": "stable-audio-3 LoRA via cj_sa3_audio/tools/sa3_lora_to_comfy.py",
        "sa3_lora_config": json.dumps(lcfg),
        "base_model": model_name,
        "energy": str(energy),
    }
    save_file(out, out_path, metadata=meta)
    worst = max(e for _, _, e in report)
    ranks = sorted({str(r) for _, r, _ in report})
    print(f"wrote {out_path}: {len(report)} layers, ranks {ranks}, "
          f"worst low-rank rel err {worst:.2e}, adapter {lcfg.get('adapter_type')}")
    if ref_path:
        save_file({k: v.contiguous() for k, v in refs.items()}, ref_path)
    if skipped:
        print(f"WARNING: skipped {len(skipped)} conditioner layers (no ComfyUI target): "
              f"{skipped[:3]}{'...' if len(skipped) > 3 else ''}", file=sys.stderr)
    return report


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--model", default="medium-base")
    ap.add_argument("--energy", type=float, default=0.9999)
    ap.add_argument("--max_rank", type=int, default=128)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--ref", help="also save SA3-merged weights of a few layers (for tests)")
    a = ap.parse_args()
    convert(a.src, a.dst, a.model, a.energy, a.max_rank, a.device, a.ref)


if __name__ == "__main__":
    main()

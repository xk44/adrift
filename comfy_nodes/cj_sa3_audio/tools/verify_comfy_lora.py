"""Check a converted SA3 LoRA inside ComfyUI: every key loads, and ComfyUI's
patched weights equal the SA3-merged reference weights (from --ref).

  ComfyUI/venv/bin/python verify_comfy_lora.py <ComfyUI dir> <checkpoint> comfy_lora.safetensors ref.safetensors
"""
import logging
import sys


def main():
    comfy_dir, ckpt, lora_path, ref_path = sys.argv[1:5]
    sys.path.insert(0, comfy_dir)
    import torch
    from comfy.cli_args import args
    if not torch.cuda.is_available():
        args.cpu = True
    import comfy.lora
    import comfy.sd
    import comfy.utils

    unloaded = []

    class Catch(logging.Handler):
        def emit(self, rec):
            msg = rec.getMessage()
            if "not loaded" in msg:
                unloaded.append(msg)

    logging.getLogger().addHandler(Catch())
    model = comfy.sd.load_checkpoint_guess_config(ckpt, output_vae=False, output_clip=False)[0]
    lora = comfy.utils.load_torch_file(lora_path)
    patched, _ = comfy.sd.load_lora_for_models(model, None, lora, 1.0, 0)
    refs = comfy.utils.load_torch_file(ref_path)
    n_layers = len({k.rsplit(".", 2)[0] for k in lora if not k.endswith(".alpha")})
    print(f"lora layers {n_layers}, patched weights {len(patched.patches)}, unloaded keys {len(unloaded)}")
    for u in unloaded[:5]:
        print("  ", u)
    sd = patched.model.state_dict()
    worst = 0.0
    for name, ref in refs.items():
        k = f"diffusion_model.{name}.weight"
        assert k in patched.patches, f"no patch for {k}"
        w = sd[k].float().clone()
        out = comfy.lora.calculate_weight(patched.patches[k], w, k, intermediate_dtype=torch.float32)
        ref = ref.float()
        err = float((out - ref).norm() / (ref - sd[k].float()).norm().clamp_min(1e-12))
        base = float((sd[k].float() - ref).norm() / ref.norm())
        worst = max(worst, err)
        print(f"  {name}: err/|delta| {err:.2e}  (|delta|/|W| {base:.2e})")
    ok = not unloaded and worst < 5e-3
    print("PASS" if ok else "FAIL", f"worst {worst:.2e}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

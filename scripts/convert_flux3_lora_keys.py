#!/usr/bin/env python3
"""Rename a diffusers-format FLUX.3 Klein LoRA to ComfyUI key names.

Some FLUX.3 Klein LoRAs on Hugging Face (e.g. the camera-angles LoRA used by
the "Camera angle" edit tool) ship with diffusers module names, which
ComfyUI's LoraLoaderModelOnly silently ignores (the LoRA loads with 0 keys
matched and the edit does nothing). This rewrites only the tensor names; the
tensor bytes and the __metadata__ block are copied unchanged, so no torch or
safetensors package is needed.

  python3 scripts/convert_flux3_lora_keys.py pytorch_lora_weights.safetensors \
      ComfyUI/models/loras/edit_tools/flux3_klein_angles_comfy.safetensors

  --check  only print how many keys would be renamed / left unmapped.
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import sys
from pathlib import Path

# Order matters: block prefixes first, then the module names inside a block.
RULES: list[tuple[str, str]] = [
    (r"^transformer\.mode_blocks\.", "diffusion_model.content_mode_blocks."),
    (r"^transformer\.single_transformer_blocks\.", "diffusion_model.single_blocks."),
    (r"^transformer\.", "diffusion_model."),
    (r"\.attn\.to_q\.", ".q_proj."),
    (r"\.attn\.to_k\.", ".k_proj."),
    (r"\.attn\.to_v\.", ".v_proj."),
    (r"\.attn\.to_out\.0\.", ".attn_out."),
    (r"\.ff\.linear_in\.", ".mlp_in."),
    (r"\.ff\.linear_out\.", ".mlp_out."),
]


def convert_key(key: str) -> str:
    for pat, rep in RULES:
        key = re.sub(pat, rep, key)
    return key


def read_header(path: Path) -> tuple[dict, int]:
    with path.open("rb") as f:
        (n,) = struct.unpack("<Q", f.read(8))
        return json.loads(f.read(n)), 8 + n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("src", type=Path)
    ap.add_argument("dst", type=Path, nargs="?")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()

    header, offset = read_header(a.src)
    meta = header.pop("__metadata__", None)
    renamed = {convert_key(k): v for k, v in header.items()}
    if len(renamed) != len(header):
        print("error: two keys map to the same name", file=sys.stderr)
        return 1
    unmapped = sorted(k for k in renamed if not k.startswith("diffusion_model."))
    changed = sum(1 for k in header if convert_key(k) != k)
    print(f"{len(header)} tensors, {changed} renamed, {len(unmapped)} unmapped")
    for k in unmapped[:10]:
        print("  unmapped:", k)
    if a.check:
        return 0 if not unmapped else 1
    if a.dst is None:
        ap.error("dst is required unless --check")
    if a.dst.exists():
        print(f"error: {a.dst} exists", file=sys.stderr)
        return 1

    # Keep each tensor's data_offsets: the data section is copied byte for byte.
    out = dict(sorted(renamed.items(), key=lambda kv: kv[1]["data_offsets"][0]))
    if meta is not None:
        out = {"__metadata__": meta, **out}
    blob = json.dumps(out, separators=(",", ":")).encode()
    blob += b" " * (-len(blob) % 8)  # 8-byte alignment, as safetensors writes it
    a.dst.parent.mkdir(parents=True, exist_ok=True)
    with a.src.open("rb") as fi, a.dst.open("wb") as fo:
        fo.write(struct.pack("<Q", len(blob)))
        fo.write(blob)
        fi.seek(offset)
        while chunk := fi.read(1 << 24):
            fo.write(chunk)
    print("wrote", a.dst)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Install the third-party ComfyUI node packs Adrift uses, at the commits
pinned in docs/custom-nodes.json, with the required patches applied.

    python3 docker/install-comfy-packs.py <custom_nodes dir> [--meta docs/custom-nodes.json]
                                          [--only id,id] [--skip-optional]

Pack Python dependencies are NOT installed from each pack's requirements.txt
(those are unpinned and pull GUI/CUDA extras); the image installs the pinned
set in docker/comfyui-packs-requirements.txt instead.

Idempotent: a pack already at the pinned commit only gets missing patches.
Platform patches (Apple MPS) apply only on a matching host.
"""

from __future__ import annotations

import argparse
import json
import os
import platform as platform_mod
import shutil
import subprocess
import sys
import tempfile

MARKER = ".adrift-commit"  # pin record for packs copied out of a repo subdirectory


def run(cmd, cwd=None):
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, check=True)


def head(path):
    marker = os.path.join(path, MARKER)
    if os.path.isfile(marker):
        return open(marker).read().strip()
    try:
        return subprocess.run(["git", "-C", path, "rev-parse", "HEAD"], check=True,
                              capture_output=True, text=True).stdout.strip()
    except Exception:
        return None


def platform_applies(platform):
    """Platform-specific patches apply only on the matching host."""
    if not platform:
        return True
    if "MPS" in platform:
        return sys.platform == "darwin" and platform_mod.machine() == "arm64"
    return False


def wanted_patches(pack):
    for p in pack.get("patches", []):
        if p.get("platform"):
            if platform_applies(p["platform"]):
                yield p
        elif p.get("required"):
            yield p


def apply_patches(pack, root, meta_dir, directory=None):
    """Apply the pack's patches inside `root` (the pack root, or the clone
    root with `directory` = subdir). Already-applied patches are skipped, so
    re-running on an existing install is safe."""
    # Stop git from discovering an enclosing repository (ComfyUI itself is a
    # git checkout): patch paths are relative to `root`, never a parent repo.
    env = dict(os.environ, GIT_CEILING_DIRECTORIES=os.path.dirname(os.path.abspath(root)))
    for p in wanted_patches(pack):
        base = ["git", "apply"] + ([f"--directory={directory}"] if directory else [])
        path = os.path.join(meta_dir, p["file"])
        rev = subprocess.run(base + ["--check", "-R", path], cwd=root, env=env, capture_output=True)
        if rev.returncode == 0:
            print(f"= {pack['id']}: {os.path.basename(path)} already applied")
            continue
        fwd = subprocess.run(base + ["--check", path], cwd=root, env=env, capture_output=True, text=True)
        if fwd.returncode != 0:
            raise SystemExit(f"{pack['id']}: {os.path.basename(path)} does not apply in {root}:\n{fwd.stderr}")
        print("+", " ".join(base + [path]), flush=True)
        subprocess.run(base + [path], cwd=root, env=env, check=True)


def install(pack, dest_root, meta_dir):
    dest = os.path.join(dest_root, pack["dir"])
    commit = pack["commit"]
    if os.path.isdir(dest):
        if head(dest) == commit:
            print(f"= {pack['id']} already at {commit[:8]}")
            # An existing checkout (e.g. from ComfyUI-Manager) may lack our patches.
            apply_patches(pack, dest, meta_dir)
            return
        raise SystemExit(f"{dest} exists but is not at {commit[:8]}; move it aside first")
    sub = pack.get("subdir")
    src = tempfile.mkdtemp(prefix=pack["id"] + "-") if sub else dest
    os.makedirs(src, exist_ok=True)
    run(["git", "init", "-q"], cwd=src)
    run(["git", "remote", "add", "origin", pack["repo"]], cwd=src)
    run(["git", "fetch", "-q", "--depth", "1", "origin", commit], cwd=src)
    run(["git", "-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"], cwd=src)
    if pack.get("recursive"):
        run(["git", "submodule", "update", "-q", "--init", "--recursive", "--depth", "1"], cwd=src)
    # Patch paths are relative to the pack root. Apply them inside the clone
    # (a repo root), so git never resolves them against an enclosing repo.
    apply_patches(pack, src, meta_dir, directory=sub)
    if sub:
        shutil.copytree(os.path.join(src, sub), dest)
        with open(os.path.join(dest, MARKER), "w") as f:
            f.write(commit + "\n")
        shutil.rmtree(src)  # temporary clone created above
    print(f"+ {pack['id']} @ {commit[:8]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dest")
    ap.add_argument("--meta", default="docs/custom-nodes.json")
    ap.add_argument("--only", default="")
    ap.add_argument("--skip-optional", action="store_true")
    a = ap.parse_args()
    meta_path = os.path.abspath(a.meta)
    # patch paths in the meta are relative to the repository root (docs/patches/...)
    meta_dir = os.path.dirname(os.path.dirname(meta_path))
    meta = json.load(open(meta_path))
    only = {s for s in a.only.split(",") if s}
    packs = [p for p in meta["packs"]
             if (not only or p["id"] in only) and not (a.skip_optional and p.get("optional"))]
    missing = only - {p["id"] for p in packs}
    if missing:
        sys.exit(f"unknown pack ids: {', '.join(sorted(missing))}")
    for p in packs:
        if not p.get("repo") or not p.get("commit"):
            sys.exit(f"pack {p['id']} has no repo/commit pin")
        install(p, a.dest, meta_dir)


if __name__ == "__main__":
    main()

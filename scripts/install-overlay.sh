#!/usr/bin/env bash
# Install the Adrift overlay bridge (adrift_overlay custom node) into
# one or more ComfyUI installs — browser ComfyUI and/or the desktop app.
#
# Usage:
#   scripts/install-overlay.sh                   # auto-discover targets
#   scripts/install-overlay.sh /path/to/Comfy... # also link into these bases
#
# A target is any directory containing custom_nodes/. The node is linked
# (a symlink custom_nodes/adrift_overlay -> this repo) so repo updates apply
# without reinstalling. Re-running is safe: an existing link is refreshed,
# while a real adrift_overlay directory is never touched. Nothing is written
# anywhere except that one symlink per target. Restart ComfyUI after
# installing. Toggle the overlay with the corner button or Ctrl+Shift+J.
# An older custom_nodes/sref_system link is left alone (it still provides
# the sref / LoRA shortcode nodes); the overlay just lives here now.
#
# If your ComfyUI serves on a port other than 8188/8000, allow it to embed
# CJ by setting CJ_FRAME_ANCESTORS (space-separated origins) for the CJ
# server, e.g.: CJ_FRAME_ANCESTORS="http://localhost:9999" npm run dev
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SRC="$SCRIPT_DIR/../comfy_nodes/adrift_overlay"
OLD_SRC="$(cd "$SCRIPT_DIR/../comfy_nodes/sref_system" 2>/dev/null && pwd -P || true)"

if [[ ! -d "$NODE_SRC" ]]; then
  echo "error: node source not found: $NODE_SRC" >&2
  exit 1
fi
NODE_SRC="$(cd "$NODE_SRC" && pwd -P)"

# Physical absolute path of an existing directory ("" if it is not one).
canon() {
  [[ -n "$1" && -d "$1" ]] || return 0
  (cd -- "$1" 2>/dev/null && pwd -P) || true
}

targets=()
add_target() {
  local base
  base="$(canon "$1")"
  [[ -n "$base" && -d "$base/custom_nodes" ]] || return 1
  targets+=("$base")
}

# 1. Dev-setup ComfyUI checkout (same convention as start-comfyui.sh)
add_target "${COMFY_ROOT:-${COMFY_DIR:-$SCRIPT_DIR/../../../ComfyUI}}" || true

# 2. ComfyUI desktop app — basePath from its config (electron-store)
cfgs=("$HOME/.config/ComfyUI/config.json"
      "$HOME/Library/Application Support/ComfyUI/config.json")
[[ -n "${APPDATA:-}" ]] && cfgs+=("$APPDATA/ComfyUI/config.json")
for cfg in "${cfgs[@]}"; do
  [[ -f "$cfg" ]] || continue
  base="$(python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get("basePath",""); print(v if isinstance(v,str) else "")' "$cfg" 2>/dev/null || true)"
  # Only absolute paths: a relative basePath would resolve against our cwd.
  [[ "$base" == /* || "$base" =~ ^[A-Za-z]:[\\/] ]] || continue
  add_target "$base" || true
done

# 3. Explicit path arguments
for arg in "$@"; do
  if ! add_target "$arg"; then
    echo "error: $arg has no custom_nodes/ directory" >&2
    exit 1
  fi
done

if [[ ${#targets[@]} -eq 0 ]]; then
  echo "No ComfyUI installs found. Pass the base path explicitly:" >&2
  echo "  $0 /path/to/ComfyUI" >&2
  exit 1
fi

# Dedupe + link. Newline-delimited list instead of `declare -A`: macOS ships
# bash 3.2, which has no associative arrays ("declare: -A: invalid option").
seen=$'\n'
failed=0
for base in "${targets[@]}"; do
  case "$seen" in *$'\n'"$base"$'\n'*) continue ;; esac
  seen+="$base"$'\n'
  dest="$base/custom_nodes/adrift_overlay"
  old="$base/custom_nodes/sref_system"
  if [[ -n "$OLD_SRC" && -L "$old" && "$(canon "$old")" == "$OLD_SRC" ]]; then
    echo "note: $old is kept (it provides the sref/LoRA nodes); the overlay moved to adrift_overlay"
  fi

  if [[ -L "$dest" ]]; then
    if [[ "$(canon "$dest")" == "$NODE_SRC" ]]; then
      echo "already linked: $dest -> $NODE_SRC"
      continue
    fi
    # Stale or dangling link from an older checkout: replace just the link.
    # -n stops ln from descending into the directory the old link names.
    ln -sfn "$NODE_SRC" "$dest"
    echo "relinked: $dest -> $NODE_SRC"
  elif [[ -e "$dest" ]]; then
    # A real directory/file (e.g. a manual copy). `ln -sfn` would create
    # $dest/adrift_overlay inside it, so refuse instead of guessing.
    echo "error: $dest exists and is not a symlink; move it aside and re-run" >&2
    failed=1
  else
    ln -s "$NODE_SRC" "$dest"
    echo "linked: $dest -> $NODE_SRC"
  fi
done

if [[ $failed -ne 0 ]]; then
  exit 1
fi
echo "Done. Restart ComfyUI, then toggle the overlay (Ctrl+Shift+J)."

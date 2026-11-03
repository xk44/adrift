#!/usr/bin/env bash
# Start ComfyUI for Adrift.
#
# --enable-cors-header is required since ComfyUI 0.24: the origin-only
# middleware compares the Origin header's host:port against the request Host,
# so the browser's cross-port WebSocket (localhost:3000 → 127.0.0.1:8188)
# gets 403 without an explicit CORS origin.
set -euo pipefail

# ComfyUI folder: COMFY_ROOT (same variable the app reads; also picked up from
# .env.local), else the older COMFY_DIR, else ../ComfyUI next to the repo.
if [ -z "${COMFY_ROOT:-}" ] && [ -z "${COMFY_DIR:-}" ] && [ -f "$(dirname "$0")/../.env.local" ]; then
  COMFY_ROOT="$(sed -n 's/^COMFY_ROOT=//p' "$(dirname "$0")/../.env.local" | tail -n 1 | tr -d "\"'\r")"
  case "$COMFY_ROOT" in
    "~/"*) COMFY_ROOT="$HOME/${COMFY_ROOT#\~/}" ;;
    /*|"") ;;
    *) COMFY_ROOT="$(dirname "$0")/../$COMFY_ROOT" ;; # relative to the app folder, like the app
  esac
fi
COMFY_DIR="${COMFY_ROOT:-${COMFY_DIR:-}}"
# Default: ComfyUI next to the app folder (where ./install.sh --install-comfy
# puts it), else one level further up. A missing folder is reported below
# with guidance rather than a bare cd error.
if [ -z "$COMFY_DIR" ]; then
  APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  for c in "$APP_DIR/../ComfyUI" "$APP_DIR/../../ComfyUI"; do
    if [ -f "$c/main.py" ]; then COMFY_DIR="$(cd "$c" && pwd)"; break; fi
  done
  COMFY_DIR="${COMFY_DIR:-$APP_DIR/../ComfyUI}"
fi
CJ_ORIGIN="${CJ_ORIGIN:-http://localhost:3000}"
LISTEN="${COMFY_LISTEN:-127.0.0.1}"
PORT="${COMFY_PORT:-8188}"
# Latent previews over the WebSocket (Adrift shows them on in-progress tiles).
# auto = TAESD when its decoder is installed, else latent2rgb. "none" disables.
PREVIEW_METHOD="${CJ_PREVIEW_METHOD:-auto}"

# ComfyUI's own Python environment: venv/ or .venv/ (Linux/macOS), or
# venv\Scripts\python.exe (Windows Git Bash). COMFY_PYTHON overrides.
PYTHON="${COMFY_PYTHON:-}"
if [ -z "$PYTHON" ]; then
  for c in "$COMFY_DIR/venv/bin/python" "$COMFY_DIR/.venv/bin/python" "$COMFY_DIR/venv/Scripts/python.exe" "$COMFY_DIR/.venv/Scripts/python.exe"; do
    if [ -x "$c" ]; then PYTHON="$c"; break; fi
  done
fi
if [ ! -f "$COMFY_DIR/main.py" ]; then
  echo "error: no ComfyUI found at $COMFY_DIR (no main.py there)" >&2
  echo "  Use an existing ComfyUI:   ./install.sh --comfy /path/to/ComfyUI   (writes COMFY_ROOT to .env.local)" >&2
  echo "  Or a remote one:           ./install.sh --remote http://HOST:8188   (nothing to start here)" >&2
  echo "  Or install one (~6 GB):    ./install.sh --install-comfy" >&2
  echo "  One-off: COMFY_ROOT=/path/to/ComfyUI scripts/start-comfyui.sh" >&2
  exit 1
fi
if [ -z "$PYTHON" ]; then
  echo "error: ComfyUI at $COMFY_DIR has no venv/ or .venv/ with its Python" >&2
  echo "  Create it with ComfyUI's dependencies and GPU PyTorch:  ./install.sh --install-comfy $COMFY_DIR" >&2
  echo "  (it reuses the existing folder), or point COMFY_PYTHON at the Python that runs this ComfyUI." >&2
  exit 1
fi
# Fail fast, with the fix, when the port is taken (ComfyUI would only log
# "address already in use" and exit).
if command -v curl >/dev/null 2>&1 && curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT"; then
  if curl -sf -m 2 -o /dev/null "http://127.0.0.1:$PORT/system_stats"; then
    echo "ComfyUI is already running on port $PORT; nothing to do." >&2
    exit 0
  fi
  echo "error: port $PORT is in use by another program. Stop it, or use another port: COMFY_PORT=8190 $0" >&2
  exit 1
fi

# macOS video-precision gate (opt-in, OFF by default).
# LTX/Wan video diffusion NaNs to BLACK frames in fp16 on Apple Silicon (MPS);
# --fp32-unet --fp32-vae fixes it. These are GLOBAL flags — they also force image
# models (krea2) to fp32, which is ~60% slower and changes their output — so they
# are enabled ONLY when CJ_VIDEO_FP32=1, i.e. for a dedicated VIDEO instance:
#   CJ_VIDEO_FP32=1 COMFY_PORT=8189 scripts/start-comfyui.sh
# Then point Adrift at it: COMFY_VIDEO_HTTP_URL=http://127.0.0.1:8189 in .env.local
# Default (image) instances are unaffected; Linux/CUDA never needs this.
EXTRA_ARGS=()
if [ "$(uname)" = "Darwin" ] && [ "${CJ_VIDEO_FP32:-0}" = "1" ]; then
  EXTRA_ARGS+=(--fp32-unet --fp32-vae)
fi

# RAM headroom for ComfyUI's RAM-pressure cache (its default mode). The cache
# only frees memory between nodes, and by default keeps just 10% of RAM (max
# 10 GB) free, so a big loader (MiniMax H3 stages ~38 GB in one node) after a
# few other tools OOM-kills ComfyUI. Keep min(40 GB, 45% of RAM) free instead:
# a 93 GB box that died at 54 GB cached ran the same 16-tool sequence clean
# with 23 GB to spare. Override with CJ_CACHE_RAM=<GB>, or 0 to leave it off.
# Skipped when you pass your own --cache-* flag or ComfyUI predates --cache-ram.
CACHE_RAM="${CJ_CACHE_RAM:-auto}"
case " $* " in *" --cache-"*) CACHE_RAM=0 ;; esac
if [ "$CACHE_RAM" = "auto" ]; then
  if [ "$(uname)" = "Darwin" ]; then
    RAM_GB=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
  else
    RAM_GB=$(( $(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0) / 1048576 ))
  fi
  CACHE_RAM=$(( RAM_GB * 45 / 100 ))
  [ "$CACHE_RAM" -gt 40 ] && CACHE_RAM=40
fi
if [ "${CACHE_RAM:-0}" != "0" ] && grep -q -- '"--cache-ram"' "$COMFY_DIR/comfy/cli_args.py" 2>/dev/null; then
  EXTRA_ARGS+=(--cache-ram "$CACHE_RAM")
fi

exec "$PYTHON" "$COMFY_DIR/main.py" \
  --listen "$LISTEN" \
  --port "$PORT" \
  --enable-cors-header "$CJ_ORIGIN" \
  --preview-method "$PREVIEW_METHOD" \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} \
  "$@"

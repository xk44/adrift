#!/bin/sh
# StyleVault service: setup, start, index <folder>
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SERVICE="$ROOT/services/stylevault"
VENV="$SERVICE/.venv"
PY="${STYLEVAULT_PYTHON:-$VENV/bin/python}"

usage() {
  echo "Usage: $0 setup | start | index <folder>"
}

check_python() {
  "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null
}

need_venv() {
  if [ ! -x "$PY" ] && ! command -v "$PY" >/dev/null 2>&1; then
    echo "StyleVault is not set up. Run: $0 setup" >&2
    exit 1
  fi
}

# Value from the environment, else from .env.local. Never evaluates the file.
read_setting() {
  value=$(printenv "$1" || true)
  if [ -z "$value" ] && [ -f "$ROOT/.env.local" ]; then
    value=$(sed -n "s/^$1=//p" "$ROOT/.env.local" | tail -n 1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//')
  fi
  printf '%s' "$value"
}

default_roots() {
  if [ -n "${STYLEVAULT_ALLOWED_ROOTS:-}" ]; then
    return 0
  fi
  roots=$(read_setting CJ_VAULT_DATASET_ROOTS | tr ' ,' '::')
  # Same order as Adrift: COMFYUI_OUTPUT_DIR, then COMFY_ROOT, then ../ComfyUI.
  output=$(read_setting COMFYUI_OUTPUT_DIR)
  if [ -z "$output" ]; then
    comfy=$(read_setting COMFY_ROOT)
    output="${comfy:-$ROOT/../ComfyUI}/output"
  fi
  # Adrift's data folder holds the images Datasets sends for training.
  data=$(read_setting ADRIFT_DATA_DIR)
  STYLEVAULT_ALLOWED_ROOTS="${roots}${roots:+:}${output}:${data:-$ROOT/data}"
  export STYLEVAULT_ALLOWED_ROOTS
  if [ -z "$STYLEVAULT_ALLOWED_ROOTS" ]; then
    echo "Note: no folders can be indexed through the server until you set STYLEVAULT_ALLOWED_ROOTS." >&2
  fi
}

# Lets the service deploy a finished LoRA into ComfyUI.
default_comfy_path() {
  if [ -n "${STYLEVAULT_COMFYUI_PATH:-}" ]; then
    return 0
  fi
  comfy=$(read_setting COMFY_ROOT)
  comfy="${comfy:-$ROOT/../ComfyUI}"
  if [ -d "$comfy" ]; then
    STYLEVAULT_COMFYUI_PATH=$(CDPATH= cd -- "$comfy" && pwd)
    export STYLEVAULT_COMFYUI_PATH
  fi
}

# The running service, so index finds it on a custom host or port.
default_api_url() {
  if [ -n "${STYLEVAULT_API_URL:-}" ]; then
    return 0
  fi
  url=$(read_setting STYLEVAULT_API_URL)
  if [ -z "$url" ]; then
    host="${STYLEVAULT_HOST:-127.0.0.1}"
    if [ "$host" = "0.0.0.0" ]; then host=127.0.0.1; fi
    url="http://$host:${STYLEVAULT_PORT:-8000}"
  fi
  STYLEVAULT_API_URL=$url
  export STYLEVAULT_API_URL
}

cmd=${1:-}
case "$cmd" in
  setup)
    if command -v uv >/dev/null 2>&1; then
      uv venv --python ">=3.11" "$VENV"
      uv pip install --python "$VENV/bin/python" -e "$SERVICE"
    else
      if ! command -v python3 >/dev/null 2>&1 || ! check_python python3; then
        echo "StyleVault needs Python 3.11 or newer." >&2
        exit 1
      fi
      python3 -m venv "$VENV"
      "$VENV/bin/python" -m pip install -e "$SERVICE"
    fi
    echo "Done. Start it with: $0 start"
    ;;
  start)
    need_venv
    default_roots
    default_comfy_path
    exec "$PY" -m stylevault api \
      --host "${STYLEVAULT_HOST:-127.0.0.1}" \
      --port "${STYLEVAULT_PORT:-8000}"
    ;;
  index)
    if [ "$#" -ne 2 ]; then
      usage >&2
      exit 2
    fi
    need_venv
    default_api_url
    exec "$PY" -m stylevault index "$2"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

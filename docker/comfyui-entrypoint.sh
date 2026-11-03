#!/bin/sh
# Starts ComfyUI with Adrift's container layout.
#   COMFY_DEVICE_ARGS  "--cpu" for CPU-only, empty for GPU (default: empty)
#   COMFY_VRAM_ARGS    e.g. "--reserve-vram 1" or "--lowvram" (default: empty =
#                      ComfyUI's dynamic VRAM management)
#   COMFY_CORS_ORIGIN  browser origin of Adrift (e.g. http://host:3044); the
#                      ComfyUI WebSocket rejects cross-origin clients without it
#   COMFY_EXTRA_ARGS   anything else, appended last
# /opt/ComfyUI/extra_model_paths.yaml (models under /models) is loaded by
# ComfyUI itself. A user file at /data/extra_model_paths.yaml is added on top,
# e.g. to map another model library mounted at /extra-models.
set -eu
mkdir -p /data/user /data/input /data/output /data/temp /data/home

EXTRA_PATHS=""
if [ -f /data/extra_model_paths.yaml ]; then
  EXTRA_PATHS="--extra-model-paths-config /data/extra_model_paths.yaml"
fi

CORS=""
if [ -n "${COMFY_CORS_ORIGIN:-}" ]; then
  CORS="--enable-cors-header ${COMFY_CORS_ORIGIN}"
fi

# shellcheck disable=SC2086
exec python /opt/ComfyUI/main.py \
  --listen 0.0.0.0 --port 8188 \
  --disable-auto-launch \
  --user-directory /data/user \
  --input-directory /data/input \
  --output-directory /data/output \
  --temp-directory /data \
  ${EXTRA_PATHS} \
  ${CORS} \
  ${COMFY_DEVICE_ARGS:-} \
  ${COMFY_VRAM_ARGS:-} \
  ${COMFY_EXTRA_ARGS:-} \
  "$@"

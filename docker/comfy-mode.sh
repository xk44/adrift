#!/bin/sh
# Switch the stack's ComfyUI between GPU and CPU mode.
# Run from the directory holding docker-compose.yml and .env:
#   sh comfy-mode.sh gpu    # or: cpu
set -eu
MODE="${1:-}"
case "$MODE" in
  gpu) OTHER=comfyui-cpu ;;
  cpu) OTHER=comfyui ;;
  *) echo "usage: $0 gpu|cpu" >&2; exit 2 ;;
esac
[ -f .env ] && [ -f docker-compose.yml ] || { echo "run from the compose directory (needs .env + docker-compose.yml)" >&2; exit 1; }
if [ "$MODE" = gpu ] && command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi -L >/dev/null || { echo "nvidia-smi sees no GPU; not switching" >&2; exit 1; }
fi
if grep -q '^COMPOSE_PROFILES=' .env; then
  sed -i.bak "s/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=$MODE/" .env && rm -f .env.bak
else
  echo "COMPOSE_PROFILES=$MODE" >> .env
fi
docker compose --profile gpu --profile cpu rm -sf "$OTHER"
docker compose up -d
docker compose ps

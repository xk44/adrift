#!/usr/bin/env bash
# Launch the full Adrift stack and open it in the browser.
#
# Idempotent: anything already running is left alone.
#   1. ComfyUI on :8188 (via scripts/start-comfyui.sh)
#   2. Adrift dev server on :3000
#   3. Opens the app (:3000) and the ComfyUI graph UI (:8188)
#
# Knobs (used by ./adrift): PORT (app port, default 3000),
# ADRIFT_COMFY=0 (don't start or open ComfyUI), ADRIFT_APP_MODE=start (serve
# the production build in .next-build instead of the dev server),
# ADRIFT_OPEN_COMFY=0 (open only the app), ADRIFT_NO_OPEN=1 (open nothing).
#
# Logs: ~/Library/Logs/adrift-{comfyui,app}.log on macOS,
#       ${XDG_STATE_HOME:-~/.local/state}/adrift/ elsewhere
#       (override: ADRIFT_LOG_DIR; the older CJ_LOG_DIR is still honored)
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$(uname)" = "Darwin" ]; then
  LOG_DIR="${ADRIFT_LOG_DIR:-${CJ_LOG_DIR:-$HOME/Library/Logs}}"
else
  LOG_DIR="${ADRIFT_LOG_DIR:-${CJ_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/adrift}}"
fi
APP_PORT="${PORT:-3000}"
APP_URL="http://localhost:$APP_PORT"
# ComfyUI must allow the app's origin (start-comfyui.sh passes it on).
export CJ_ORIGIN="${CJ_ORIGIN:-$APP_URL}"
# Same port knob start-comfyui.sh honors, so a non-default port isn't
# probed on 8188 (and the stack double-started).
COMFY_URL="http://127.0.0.1:${COMFY_PORT:-8188}"
mkdir -p "$LOG_DIR"

# up: anything answers on that URL (any HTTP status). ok: a 2xx answer.
up() { curl -s -m 2 -o /dev/null "$1"; }
ok() { curl -sf -m 2 -o /dev/null "$1"; }
# The app's health route answers {"ok":true,"comfyui":...,"uptime":N}; the
# dev server may compile it on first hit, hence the longer timeout.
is_adrift() { curl -s -m 20 "$1/api/health" 2>/dev/null | grep -q '"uptime"'; }

wait_for() { # url name seconds log [pid]
  local i
  for i in $(seq 1 "$3"); do
    up "$1" && return 0
    if [ -n "${5:-}" ] && ! kill -0 "$5" 2>/dev/null; then
      echo "error: $2 exited while starting. Last lines of $4:" >&2
      tail -n 20 "$4" 2>/dev/null | sed 's/^/  | /' >&2
      return 1
    fi
    sleep 1
  done
  echo "error: $2 did not come up at $1 within $3s. Last lines of $4:" >&2
  tail -n 20 "$4" 2>/dev/null | sed 's/^/  | /' >&2
  return 1
}

COMFY_LOG="$LOG_DIR/adrift-comfyui.log"
APP_LOG="$LOG_DIR/adrift-app.log"
COMFY_PORT_SHOWN="${COMFY_PORT:-8188}"

if [ "${ADRIFT_COMFY:-1}" != 0 ]; then
  if ok "$COMFY_URL/system_stats"; then
    echo "ComfyUI already running on :$COMFY_PORT_SHOWN"
  elif up "$COMFY_URL"; then
    # Not fatal: the app still starts and shows ComfyUI as offline.
    echo "error: port $COMFY_PORT_SHOWN is in use by another program (not ComfyUI), so ComfyUI was not started." >&2
    echo "  Stop that program, or use another port: COMFY_PORT=8190 ./adrift" >&2
    echo "  (then set COMFY_HTTP_URL=http://127.0.0.1:8190 in .env.local, or pick it in the setup wizard)" >&2
  else
    echo "starting ComfyUI..."
    nohup "$APP_DIR/scripts/start-comfyui.sh" >> "$COMFY_LOG" 2>&1 &
    COMFY_PID=$!
    # Not fatal: the app still starts and shows ComfyUI as offline.
    wait_for "$COMFY_URL/system_stats" "ComfyUI" 90 "$COMFY_LOG" "$COMFY_PID" || true
  fi
fi

if up "$APP_URL"; then
  if is_adrift "$APP_URL"; then
    echo "Adrift already running on :$APP_PORT"
  else
    echo "error: port $APP_PORT is in use by another program, not Adrift." >&2
    echo "  Stop that program, or start Adrift on another port: PORT=3001 ./adrift" >&2
    exit 1
  fi
else
  echo "starting Adrift app..."
  if [ "${ADRIFT_APP_MODE:-dev}" = start ]; then
    (cd "$APP_DIR" && NEXT_DIST_DIR=.next-build exec nohup npm run start -- -p "$APP_PORT" \
      >> "$APP_LOG" 2>&1) &
  else
    (cd "$APP_DIR" && exec nohup npm run dev -- -p "$APP_PORT" \
      >> "$APP_LOG" 2>&1) &
  fi
  APP_PID=$!
  wait_for "$APP_URL" "Adrift" 180 "$APP_LOG" "$APP_PID"
fi

open_url() {
  if [ "$(uname)" = "Darwin" ]; then
    open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1 || true
  fi
}
if [ "${ADRIFT_NO_OPEN:-0}" != 1 ]; then
  open_url "$APP_URL"
  if [ "${ADRIFT_COMFY:-1}" != 0 ] && [ "${ADRIFT_OPEN_COMFY:-1}" != 0 ]; then open_url "$COMFY_URL"; fi
fi
if [ "${ADRIFT_COMFY:-1}" != 0 ]; then
  echo "Adrift is up: $APP_URL (app) / $COMFY_URL (ComfyUI graph)"
else
  echo "Adrift is up: $APP_URL"
fi
echo "Logs: $LOG_DIR (adrift-app.log, adrift-comfyui.log)"

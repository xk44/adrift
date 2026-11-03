#!/usr/bin/env bash
# Run the Next.js dev server against a running mock-comfy (server.mjs).
#   MOCK_PORT=18999 PORT=3100 FAKE_ROOT=/tmp/mock-comfy-root scripts/mock-comfy/dev.sh
# Every backend URL points at the mock, so no request can reach a real GPU.
set -euo pipefail
cd "$(dirname "$0")/../.."
MOCK_PORT="${MOCK_PORT:-18999}"
PORT="${PORT:-3100}"
MOCK="http://127.0.0.1:${MOCK_PORT}"
export COMFY_HTTP_URL="$MOCK"
export COMFY_WS_BASE="ws://127.0.0.1:${MOCK_PORT}"
export NEXT_PUBLIC_COMFY_WS_BASE="ws://127.0.0.1:${MOCK_PORT}"
export COMFY_VIDEO_HTTP_URL=""
export KREA2_BACKEND_URL="$MOCK"
export NEVO_BACKEND_URL="$MOCK"
export STYLEVAULT_API_URL="$MOCK"
export CJ_H3_WARM_URL="$MOCK"
export NEXT_TELEMETRY_DISABLED=1
export NEXT_DIST_DIR="${NEXT_DIST_DIR:-.next-mock}"
if [ -n "${FAKE_ROOT:-}" ]; then export COMFY_ROOT="$FAKE_ROOT"; fi
exec ./node_modules/.bin/next dev -H 127.0.0.1 -p "$PORT"

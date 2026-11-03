#!/usr/bin/env bash
# Adrift installer: app dependencies, ComfyUI connection, optional build.
# macOS, Linux, WSL and Git Bash. Safe to re-run (finished steps are skipped).
# Models are NOT downloaded here: the setup wizard in the app does that.
#
#   ./install.sh                     ask about each step
#   ./install.sh --yes               take the defaults, no questions
#   ./install.sh --dry-run           print every action, change nothing
#
# ComfyUI (pick one; default: find an existing install and ask):
#   --comfy PATH            use the ComfyUI folder at PATH (the one with main.py)
#   --remote URL            use ComfyUI on another machine, e.g. http://gpu-box:8188
#   --install-comfy [DIR]   install ComfyUI + PyTorch into DIR (default ../ComfyUI), ~6 GB
#   --no-comfy              skip; set it up later in the app
#
# Other options:
#   --packs / --no-packs    install the pinned third-party node packs (default: no)
#   --build / --no-build    production build for fast page loads (default: yes)
#   --start / --no-start    start Adrift when done (default: ask; no with --yes)
#   -h, --help              show this help
#
# Environment: ADRIFT_TORCH_INDEX overrides the PyTorch wheel index URL.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

COMFY_GIT_URL="https://github.com/Comfy-Org/ComfyUI"
COMFY_COMMIT="e3bee7ffcb7d6547ed0bcd15221792f3b8646b17" # tested core (v0.42.0 + 7), as docker/Dockerfile.comfyui
TORCH_BASE="https://download.pytorch.org/whl"

YES=0; DRY=0; MODE=""; COMFY_ARG=""; PACKS=""; BUILD=""; START=""
usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; }
set_mode() {
  if [ -n "$MODE" ] && [ "$MODE" != "$1" ]; then
    echo "✗ pick one of --comfy, --remote, --install-comfy, --no-comfy" >&2; exit 2
  fi
  MODE="$1"
}
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -y|--yes) YES=1 ;;
    -n|--dry-run) DRY=1 ;;
    --comfy) [ $# -ge 2 ] || { echo "✗ --comfy needs a folder" >&2; exit 2; }; set_mode path; COMFY_ARG="$2"; shift ;;
    --comfy=*) set_mode path; COMFY_ARG="${1#*=}" ;;
    --remote) [ $# -ge 2 ] || { echo "✗ --remote needs a URL" >&2; exit 2; }; set_mode remote; COMFY_ARG="$2"; shift ;;
    --remote=*) set_mode remote; COMFY_ARG="${1#*=}" ;;
    --install-comfy)
      set_mode install
      if [ $# -ge 2 ] && [ "${2#-}" = "$2" ]; then COMFY_ARG="$2"; shift; fi ;;
    --install-comfy=*) set_mode install; COMFY_ARG="${1#*=}" ;;
    --no-comfy) set_mode none ;;
    --packs) PACKS=1 ;;
    --no-packs) PACKS=0 ;;
    --build) BUILD=1 ;;
    --no-build) BUILD=0 ;;
    --start) START=1 ;;
    --no-start) START=0 ;;
    *) echo "✗ unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

# ── output helpers ──────────────────────────────────────────────────────────
CURRENT_STEP="starting"; DIED=0
step() { CURRENT_STEP="$*"; printf '\n→ %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
did()  { if [ "$DRY" = 1 ]; then printf '✓ %s (dry run)\n' "$*"; else ok "$@"; fi; }
note() { printf '  %s\n' "$*"; }
warn() { printf '! %s\n' "$*"; }
die()  { DIED=1; printf '✗ %s\n' "$*" >&2; exit 1; }
show() { local out="" a; for a in "$@"; do out="$out $(printf '%q' "$a")"; done; printf '%s' "${out# }"; }
# run CMD...: print it, then run it (only print it with --dry-run)
run() {
  if [ "$DRY" = 1 ]; then printf '  [dry-run] %s\n' "$(show "$@")"; return 0; fi
  printf '  $ %s\n' "$(show "$@")"
  local rc=0
  "$@" || rc=$?
  [ "$rc" = 0 ] || die "failed (exit $rc): $(show "$@")"
}
# Never stop without saying where it stopped and what to do next.
on_exit() {
  local rc=$?
  [ "$rc" = 0 ] && return 0
  [ "$DIED" = 1 ] || printf '✗ stopped (exit %s)\n' "$rc" >&2
  printf '  Step: %s\n' "$CURRENT_STEP" >&2
  if [ "$CURRENT_STEP" = "App dependencies" ]; then
    printf '  npm failed. Use a Node.js LTS release (prebuilt better-sqlite3), or add build tools:\n' >&2
    printf '    macOS: xcode-select --install    Debian/Ubuntu: sudo apt install build-essential python3\n' >&2
  fi
  printf '  Fix the error above, then run ./install.sh again: finished steps are skipped.\n' >&2
}
trap on_exit EXIT
interactive() { [ "$YES" = 0 ] && [ -t 0 ]; }
# ask_yn "question" Y|N  -> 0 for yes
ask_yn() {
  local hint="[y/N]" reply=""
  [ "$2" = Y ] && hint="[Y/n]"
  if ! interactive; then
    printf '  %s %s %s\n' "$1" "$hint" "$([ "$2" = Y ] && echo yes || echo no)"
    [ "$2" = Y ]; return
  fi
  read -r -p "  $1 $hint " reply || reply=""
  case "$reply" in [Yy]*) return 0 ;; [Nn]*) return 1 ;; *) [ "$2" = Y ] ;; esac
}
expand_path() { # ~ and relative -> absolute (the folder need not exist)
  local p="$1"
  case "$p" in "~") p="$HOME" ;; "~/"*) p="$HOME/${p#\~/}" ;; esac
  case "$p" in /*|[A-Za-z]:*) ;; *) p="$PWD/$p" ;; esac
  if [ -d "$p" ]; then (cd "$p" && pwd); else printf '%s\n' "$p"; fi
}
# Path as Node on this OS reads it (Git Bash /c/x -> C:/x).
native_path() {
  if [ "$OS" = windows ] && command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi
}

# ── 1. preflight ────────────────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux) if grep -qi microsoft /proc/version 2>/dev/null; then OS=wsl; else OS=linux; fi ;;
  MINGW*|MSYS*|CYGWIN*) OS=windows ;;
  *) OS=other ;;
esac
ARCH="$(uname -m)"
[ "$DRY" = 1 ] && echo "Dry run: nothing is installed or written."

node_help() {
  echo "  Install Node.js 20 or newer (an LTS release), then run ./install.sh again:"
  case "$OS" in
    mac) echo "    brew install node@22        (Homebrew)  or the LTS installer from https://nodejs.org" ;;
    windows) echo "    winget install OpenJS.NodeJS.LTS        or the LTS installer from https://nodejs.org" ;;
    *) echo "    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
       echo "    then open a new terminal and run:  nvm install --lts"
       echo "    (or your distribution's nodejs 20+ package, or https://nodejs.org)" ;;
  esac
  [ "$OS" = wsl ] && echo "    (inside WSL, install Node in WSL itself, not the Windows one)"
}

step "Checking tools"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  DIED=1; echo "✗ Node.js and npm are needed." >&2; node_help >&2; exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
case "$NODE_MAJOR" in ''|*[!0-9]*) NODE_MAJOR=0 ;; esac
if [ "$NODE_MAJOR" -lt 20 ]; then
  DIED=1; echo "✗ Node.js $(node -v 2>/dev/null) is too old (Adrift needs 20 or newer)." >&2; node_help >&2; exit 1
fi
ok "Node.js $(node -v), npm $(npm -v)"
if [ $((NODE_MAJOR % 2)) -eq 1 ]; then
  warn "Node $NODE_MAJOR is not an LTS release; better-sqlite3 may have to compile (needs build tools)."
fi
HAVE_GIT=0; command -v git >/dev/null 2>&1 && HAVE_GIT=1

# ── 2. app dependencies ─────────────────────────────────────────────────────
step "App dependencies"
lock_sum() { cksum < package-lock.json | awk '{print $1 "-" $2}'; }
STAMP="node_modules/.adrift-lock"
if [ -f package-lock.json ]; then
  if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$(lock_sum)" ]; then
    ok "node_modules matches package-lock.json"
  elif [ -f node_modules/.package-lock.json ] && [ ! package-lock.json -nt node_modules/.package-lock.json ]; then
    ok "node_modules matches package-lock.json"
  else
    run npm ci
    if [ "$DRY" = 0 ]; then lock_sum > "$STAMP"; fi
    did "dependencies installed"
  fi
else
  run npm install
  did "dependencies installed"
fi
# The database driver is a native module: npm finishes "successfully" when its
# install script was blocked or its download failed, then every job fails later.
sqlite_ok() { node -e "new (require('better-sqlite3'))(':memory:').close()" >/dev/null 2>&1; }
if [ "$DRY" = 0 ] && ! sqlite_ok; then
  warn "better-sqlite3 did not load; rebuilding it"
  npm rebuild better-sqlite3 || true
  sqlite_ok || die "better-sqlite3 still does not load. Install a C++ toolchain and Python, or use a Node LTS release, then run: npm rebuild better-sqlite3"
  did "better-sqlite3 rebuilt"
fi

# ── 3. ComfyUI ──────────────────────────────────────────────────────────────
# A ComfyUI folder: "git" (main.py, started by ./adrift) or "desktop"
# (ComfyUI Desktop's base folder: models + venv, no main.py; the app starts it).
comfy_kind() {
  if [ -f "$1/main.py" ]; then echo git
  elif [ -d "$1/models" ] && { [ -d "$1/.venv" ] || [ -d "$1/user" ]; }; then echo desktop
  fi
}
detect_comfy() {
  local c env_root=""
  [ -f .env.local ] && env_root="$(sed -n 's/^COMFY_ROOT=//p' .env.local | tail -n 1 | tr -d "\"'\r")"
  for c in "${COMFY_ROOT:-}" "$env_root" "$APP_DIR/../ComfyUI" "$HOME/ComfyUI" "$HOME/Documents/ComfyUI" \
           "$HOME/comfy/ComfyUI" "$APP_DIR/../ComfyUI_windows_portable/ComfyUI" \
           "$APP_DIR/../../ComfyUI_windows_portable/ComfyUI"; do
    [ -n "$c" ] || continue
    c="$(expand_path "$c")"
    if [ -n "$(comfy_kind "$c")" ]; then printf '%s\n' "$c"; return 0; fi
  done
  return 1
}
is_url() { case "$1" in http://?*|https://?*) return 0 ;; *) return 1 ;; esac; }

step "ComfyUI"
if [ -z "$MODE" ]; then
  if FOUND="$(detect_comfy)"; then
    note "Found ComfyUI at $FOUND"
    if ask_yn "Use ComfyUI at $FOUND?" Y; then MODE=path; COMFY_ARG="$FOUND"; fi
  else
    note "No ComfyUI found (looked in ../ComfyUI, ~/ComfyUI, ~/Documents/ComfyUI, ~/comfy/ComfyUI)."
  fi
fi
if [ -z "$MODE" ]; then
  if interactive; then
    echo "  [1] Install ComfyUI next to Adrift (~6 GB incl. PyTorch)"
    echo "  [2] I have one: enter its folder or URL"
    echo "  [3] Skip, I'll set it up in the app"
    choice=""; read -r -p "  Choice [1]: " choice || choice=3
    case "${choice:-1}" in
      1) MODE=install ;;
      2) for _ in 1 2 3; do
           read -r -p "  ComfyUI folder or URL: " COMFY_ARG || COMFY_ARG=""
           if is_url "$COMFY_ARG"; then MODE=remote; break; fi
           if [ -n "$COMFY_ARG" ] && [ -n "$(comfy_kind "$(expand_path "$COMFY_ARG")")" ]; then MODE=path; break; fi
           warn "not a ComfyUI folder (no main.py) or http(s):// URL"
         done
         [ -n "$MODE" ] || MODE=none ;;
      *) MODE=none ;;
    esac
  else
    MODE=none
  fi
fi

ENV_SETS=()
COMFY_DIR=""; COMFY_PY=""
venv_python() { # $1 = ComfyUI folder; prints its Python if any
  local c
  for c in "$1/venv/bin/python" "$1/.venv/bin/python" "$1/venv/Scripts/python.exe" "$1/.venv/Scripts/python.exe" \
           "$1/../python_embeded/python.exe"; do
    if [ -x "$c" ]; then printf '%s\n' "$c"; return 0; fi
  done
  return 1
}
find_python() { # a Python 3.10-3.13 for the new venv
  local c v
  for c in python3.12 python3.13 python3.11 python3.10 python3 python; do
    command -v "$c" >/dev/null 2>&1 || continue
    v="$("$c" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)" || continue
    case "$v" in 3.10|3.11|3.12|3.13) printf '%s\n' "$c"; return 0 ;; esac
  done
  return 1
}
pick_torch_index() {
  if [ -n "${ADRIFT_TORCH_INDEX:-}" ]; then TORCH_INDEX="$ADRIFT_TORCH_INDEX"; TORCH_WHY="ADRIFT_TORCH_INDEX"; return; fi
  if [ "$OS" = mac ]; then
    TORCH_INDEX=""
    if [ "$ARCH" = arm64 ]; then TORCH_WHY="Apple Silicon (MPS)"
    else TORCH_WHY="Intel Mac, CPU only"; CPU_ONLY=1; fi
    return
  fi
  local drv="" major=0
  if command -v nvidia-smi >/dev/null 2>&1; then
    drv="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n 1 | tr -d ' \r')" || drv=""
  fi
  if [ -n "$drv" ]; then
    major="${drv%%.*}"
    case "$major" in ''|*[!0-9]*) major=0 ;; esac
    if [ "$major" -ge 580 ]; then TORCH_INDEX="$TORCH_BASE/cu130"
    elif [ "$major" -ge 570 ]; then TORCH_INDEX="$TORCH_BASE/cu128"
    else TORCH_INDEX="$TORCH_BASE/cu126"; fi
    TORCH_WHY="NVIDIA driver $drv"
  else
    TORCH_INDEX="$TORCH_BASE/cpu"; TORCH_WHY="no NVIDIA GPU found"; CPU_ONLY=1
  fi
}

case "$MODE" in
  path)
    COMFY_DIR="$(expand_path "$COMFY_ARG")"
    KIND="$(comfy_kind "$COMFY_DIR")"
    [ -n "$KIND" ] || die "$COMFY_DIR is not a ComfyUI folder (no main.py). Use --install-comfy to install one."
    ENV_SETS+=("COMFY_ROOT=$(native_path "$COMFY_DIR")")
    if [ "$KIND" = desktop ]; then
      ok "ComfyUI Desktop folder: $COMFY_DIR"
      note "Start ComfyUI Desktop yourself and add this to its server arguments (Settings > Server-Config):"
      note "  --enable-cors-header http://localhost:3000"
    else
      ok "ComfyUI: $COMFY_DIR"
      COMFY_PY="$(venv_python "$COMFY_DIR" || true)"
      [ -n "$COMFY_PY" ] || warn "no venv/ or .venv/ in $COMFY_DIR: ./adrift needs ComfyUI's own Python there."
    fi ;;
  remote)
    is_url "$COMFY_ARG" || die "--remote needs an http:// or https:// URL, e.g. http://gpu-box:8188"
    URL="${COMFY_ARG%/}"
    WS="$(printf '%s' "$URL" | sed -e 's#^http://#ws://#' -e 's#^https://#wss://#')"
    ENV_SETS+=("COMFY_HTTP_URL=$URL" "COMFY_WS_BASE=$WS" "NEXT_PUBLIC_COMFY_WS_BASE=$WS")
    ok "ComfyUI on $URL"
    if [ "$DRY" = 0 ] && command -v curl >/dev/null 2>&1; then
      if curl -s -m 4 -o /dev/null "$URL/system_stats"; then ok "it answers"
      else warn "no answer from $URL yet (fine if that machine is off)"; fi
    fi
    note "Start ComfyUI there with: --listen 0.0.0.0 --enable-cors-header http://localhost:3000"
    note "ComfyUI has no login: anyone on that network can run code on it. Safer: ssh -N -L 8188:127.0.0.1:8188 <gpu-host>, then ./install.sh --remote http://127.0.0.1:8188" ;;
  install)
    COMFY_DIR="$(expand_path "${COMFY_ARG:-$APP_DIR/../ComfyUI}")"
    [ "$HAVE_GIT" = 1 ] || die "git is needed to install ComfyUI (https://git-scm.com/downloads)"
    PY="$(find_python)" || die "Python 3.10-3.13 is needed for ComfyUI. $(case "$OS" in
      mac) echo "Try: brew install python@3.12" ;;
      windows) echo "Try: winget install Python.Python.3.12" ;;
      *) echo "Install python3.12 and python3.12-venv from your distribution." ;; esac)"
    note "Installing ComfyUI into $COMFY_DIR (~6 GB incl. PyTorch)"
    if [ -f "$COMFY_DIR/main.py" ]; then
      ok "ComfyUI already cloned"
    elif [ -e "$COMFY_DIR" ] && [ -n "$(ls -A "$COMFY_DIR" 2>/dev/null)" ]; then
      die "$COMFY_DIR exists and is not a ComfyUI folder; pick another: --install-comfy DIR"
    else
      run git clone "$COMFY_GIT_URL" "$COMFY_DIR"
      run git -C "$COMFY_DIR" checkout -q "$COMFY_COMMIT"
    fi
    COMFY_PY="$(venv_python "$COMFY_DIR" || true)"
    if [ -z "$COMFY_PY" ]; then
      if ! "$PY" -c 'import venv, ensurepip' >/dev/null 2>&1; then
        PYV="$("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo 3)"
        die "$PY cannot create a virtualenv (no venv/ensurepip). Debian/Ubuntu: sudo apt install python$PYV-venv"
      fi
      run "$PY" -m venv "$COMFY_DIR/venv"
      if [ "$DRY" = 1 ]; then COMFY_PY="$COMFY_DIR/venv/bin/python"
      else COMFY_PY="$(venv_python "$COMFY_DIR")" || die "venv creation failed in $COMFY_DIR/venv"; fi
    else
      ok "venv: $COMFY_PY"
    fi
    CPU_ONLY=0; TORCH_INDEX=""; TORCH_WHY=""
    pick_torch_index
    if [ "$DRY" = 0 ] && "$COMFY_PY" -c 'import torch' >/dev/null 2>&1; then
      ok "PyTorch already installed"
    else
      note "PyTorch: ${TORCH_INDEX:-PyPI default} ($TORCH_WHY; override with ADRIFT_TORCH_INDEX)"
      if [ "$CPU_ONLY" = 1 ]; then
        warn "No supported GPU: ComfyUI will run on the CPU and generation will be VERY slow."
      fi
      if [ -n "$TORCH_INDEX" ]; then
        run "$COMFY_PY" -m pip install torch torchvision torchaudio --index-url "$TORCH_INDEX"
      else
        run "$COMFY_PY" -m pip install torch torchvision torchaudio
      fi
    fi
    REQ_STAMP="$COMFY_DIR/venv/.adrift-requirements"
    if [ "$DRY" = 0 ] && [ -f "$REQ_STAMP" ] && [ "$(cat "$REQ_STAMP")" = "$(cksum < "$COMFY_DIR/requirements.txt")" ]; then
      ok "ComfyUI requirements already installed"
    else
      run "$COMFY_PY" -m pip install -r "$COMFY_DIR/requirements.txt"
      if [ "$DRY" = 0 ] && [ -d "$COMFY_DIR/venv" ]; then cksum < "$COMFY_DIR/requirements.txt" > "$REQ_STAMP"; fi
    fi
    KIND=git
    ENV_SETS+=("COMFY_ROOT=$(native_path "$COMFY_DIR")")
    did "ComfyUI ready: $COMFY_DIR" ;;
  none)
    ok "Skipped. The setup wizard in the app connects ComfyUI (or run ./install.sh --install-comfy later)." ;;
esac

# Optional third-party node packs (+ Adrift's own nodes), for a local git ComfyUI.
if { [ "$MODE" = path ] || [ "$MODE" = install ]; } && [ "${KIND:-}" = git ]; then
  if [ -z "$PACKS" ]; then
    if ask_yn "Install the custom node packs (pinned, ~1.5 GB)? Krea 2, the default image engine, and the full tool set need them" N; then PACKS=1; else PACKS=0; fi
  fi
  if [ "$PACKS" = 1 ]; then
    step "Node packs"
    [ "$HAVE_GIT" = 1 ] || die "git is needed for the node packs (https://git-scm.com/downloads)"
    [ -n "$COMFY_PY" ] || die "no ComfyUI Python found in $COMFY_DIR (venv/ or .venv/)"
    run "$COMFY_PY" docker/install-comfy-packs.py "$COMFY_DIR/custom_nodes"
    # Constrain the packs' deps to the versions ComfyUI is validated with, so
    # they can't move ComfyUI's own dependencies. The torch pins are left out:
    # the GPU build already installed must not be swapped for a PyPI one.
    [ -f docker/comfyui-constraints.txt ] || die "missing docker/comfyui-constraints.txt"
    PACK_CONSTRAINTS="$(mktemp "${TMPDIR:-/tmp}/adrift-constraints.XXXXXX")"
    grep -viE '^(torch|torchvision|torchaudio)==' docker/comfyui-constraints.txt > "$PACK_CONSTRAINTS" || true
    run "$COMFY_PY" -m pip install -r docker/comfyui-packs-requirements.txt -c "$PACK_CONSTRAINTS"
    rm -f "$PACK_CONSTRAINTS"
    for n in comfy_nodes/*/; do
      n="${n%/}"; dest="$COMFY_DIR/custom_nodes/$(basename "$n")"
      [ -f "$n/__init__.py" ] || continue
      if [ -e "$dest" ] || [ -L "$dest" ]; then continue; fi
      run ln -s "$APP_DIR/$n" "$dest"
    done
    did "node packs installed (restart ComfyUI to load them)"
  else
    note "Node packs skipped: each Tools card shows what it is missing and has a Set up button."
  fi
fi

# ── 4. .env.local ───────────────────────────────────────────────────────────
step "Settings (.env.local)"
ENV_ARGS=()
[ "$DRY" = 1 ] && ENV_ARGS+=(--dry-run)
node scripts/install-env.mjs ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} ${ENV_SETS[@]+"${ENV_SETS[@]}"}

# ── 5. production build ─────────────────────────────────────────────────────
step "Build"
FRESH=0
if [ -d node_modules ] && node scripts/build-fresh.mjs >/dev/null 2>&1; then FRESH=1; fi
if [ "$FRESH" = 1 ] && [ "$BUILD" != 1 ]; then
  ok "production build is up to date"
else
  if [ -z "$BUILD" ]; then
    if ask_yn "Build the app now for faster page loads? (~2 min; otherwise pages compile on first visit)" Y; then BUILD=1; else BUILD=0; fi
  fi
  if [ "$BUILD" = 1 ]; then
    run env NEXT_DIST_DIR=.next-build NEXT_TELEMETRY_DISABLED=1 ./node_modules/.bin/next build
    run node scripts/build-fresh.mjs --stamp
    did "built (.next-build)"
  else
    note "No build: ./adrift uses the dev server (first visit to each page is slow)."
  fi
fi

# ── done ────────────────────────────────────────────────────────────────────
echo
if [ "$DRY" = 1 ]; then ok "Dry run finished: nothing was changed."; else ok "Adrift is installed."; fi
case "$MODE" in
  path|install) note "ComfyUI: $COMFY_DIR" ;;
  remote) note "ComfyUI: $URL" ;;
  *) note "ComfyUI: not set up yet (the setup wizard in the app helps)" ;;
esac
note "Start it with:  ./adrift      (opens http://localhost:3000 in your browser)"
note "Optional: Map, Clusters and Images on the Styles page need a local service. See docs/STYLE_LIBRARY.md"
if [ "$DRY" = 0 ]; then
  if [ -z "$START" ]; then
    START=0
    if interactive && ask_yn "Start Adrift now?" Y; then START=1; fi
  fi
  if [ "$START" = 1 ]; then trap - EXIT; echo; exec "$APP_DIR/adrift"; fi
fi

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="${VENV_DIR:-.venv}"
INSTALL_PYTHON=0

log() {
  printf '[bootstrap] %s\n' "$*"
}

warn() {
  printf '[bootstrap] warning: %s\n' "$*" >&2
}

usage() {
  cat <<'EOF'
Usage:
  ./bootstrap.sh
  ./bootstrap.sh --python

What it does:
  - creates .env from .env.example if missing
  - installs Node dependencies with npm ci
  - optionally creates a local Python virtualenv and installs generic service deps

Notes:
  - Python mode does not install CUDA-specific Torch builds
  - Python mode does not clone MeloTTS for you
  - set PYTHON_BIN=/path/to/python or VENV_DIR=/path/to/venv before running if needed
EOF
}

for arg in "$@"; do
  case "$arg" in
    --python)
      INSTALL_PYTHON=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      warn "unknown argument: $arg"
      usage
      exit 1
      ;;
  esac
done

if ! command -v npm >/dev/null 2>&1; then
  warn "npm not found. Install Node.js 18+ first."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  warn "node not found. Install Node.js 18+ first."
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  warn "detected Node.js $(node -v), but this project requires Node.js 18+."
  exit 1
fi

if [ ! -f ".env" ]; then
  cp ".env.example" ".env"
  log "created .env from .env.example"
else
  log ".env already exists, keeping it unchanged"
fi

log "installing Node dependencies"
npm ci

if [ "$INSTALL_PYTHON" -eq 1 ]; then
  if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    warn "python interpreter not found: $PYTHON_BIN"
    exit 1
  fi

  log "creating virtualenv at $VENV_DIR"
  "$PYTHON_BIN" -m venv "$VENV_DIR"

  log "upgrading pip"
  "$VENV_DIR/bin/pip" install --upgrade pip

  log "installing generic Python service dependencies"
  "$VENV_DIR/bin/pip" install -r requirements.runtime.txt

  cat <<EOF

[bootstrap] Python environment is ready at $VENV_DIR
[bootstrap] Next:
[bootstrap]   1. edit .env
[bootstrap]   2. set VOICERUNTIME_ASR_PYTHON=$ROOT_DIR/$VENV_DIR/bin/python
[bootstrap]   3. set VOICERUNTIME_TTS_PYTHON to a Python environment that can run MeloTTS
[bootstrap]   4. set MELOTTS_REPO to your MeloTTS checkout path

EOF
else
  cat <<'EOF'

[bootstrap] Node setup is ready.
[bootstrap] Next:
[bootstrap]   1. edit .env
[bootstrap]   2. if you want a local Python env for FunASR/openWakeWord, run: ./bootstrap.sh --python
[bootstrap]   3. if you want local MeloTTS, install its Python deps and set VOICERUNTIME_TTS_PYTHON / MELOTTS_REPO

EOF
fi

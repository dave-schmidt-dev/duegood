#!/bin/sh
set -eu

umask 077
export HOME=/home/opencode
export XDG_CONFIG_HOME=/home/opencode/.config
export XDG_DATA_HOME=/home/opencode/.local/share
export XDG_CACHE_HOME=/home/opencode/.cache
export OPENCODE_CONFIG=/etc/opencode/opencode.json
export OPENCODE_CONFIG_DIR=/tmp/opencode/empty-config
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_DEFAULT_PLUGINS=1
export OPENCODE_DISABLE_LSP_DOWNLOAD=1
export OPENCODE_DISABLE_CLAUDE_CODE=1
export OPENCODE_DISABLE_MODELS_FETCH=1
export OPENCODE_ENABLE_EXA=0
export OPENCODE_ENABLE_PARALLEL=0
export NO_PROXY=""
export no_proxy=""

mkdir -p "$OPENCODE_CONFIG_DIR"

if [ "${1:-}" = "--metadata" ]; then
  printf '{"opencodeVersion":"%s","model":"%s","variant":"%s"}\n' \
    "$(opencode --version)" \
    "${DUEGOOD_OPENCODE_MODEL:-opencode-go/deepseek-v4.1-flash}" \
    "${DUEGOOD_OPENCODE_VARIANT:-high}"
  exit 0
fi

if [ "$#" -eq 0 ]; then
  echo "executor requires an explicit command" >&2
  exit 64
fi

exec "$@"

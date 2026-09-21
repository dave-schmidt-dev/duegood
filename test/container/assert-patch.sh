#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
RUNNER="$ROOT/scripts/opencode-task.sh"
mode=${1:-}

static_check() {
  grep -Fq 'GIT_CONFIG_NOSYSTEM=1' "$RUNNER"
  grep -Fq 'GIT_CONFIG_GLOBAL=/dev/null' "$RUNNER"
  grep -Fq 'core.hooksPath=/dev/null' "$RUNNER"
  grep -Fq -- '--no-ext-diff' "$RUNNER"
  grep -Fq -- '--no-textconv' "$RUNNER"
  grep -Fq 'prohibited file mode' "$RUNNER"
  grep -Fq 'prohibited object type' "$RUNNER"
  grep -Fq 'required patch is empty' "$RUNNER"
  grep -Fq 'out-of-scope path' "$RUNNER"
  grep -Fq 'source archive unexpectedly contains Git metadata' "$RUNNER"
}

live_check() {
  local task="patch-qualify-$$" state before
  state="$ROOT/.evidence/opencode/tasks/$task"
  before=$(shasum -a 256 "$ROOT/.git/index")
  trap "rm -rf -- '$state'" EXIT
  "$RUNNER" prepare "$task" >/dev/null
  printf '\ncredential-free patch qualification\n' >>"$state/source/README.md"
  "$RUNNER" export-patch "$task" --require-nonempty --allow README.md >/dev/null
  grep -Fq 'diff --git a/README.md b/README.md' "$state/patch.diff"
  [[ $(shasum -a 256 "$ROOT/.git/index") == "$before" ]]
  test ! -e "$state/source/.git"
  printf 'unexpected\n' >"$state/source/UNDECLARED"
  if "$RUNNER" export-patch "$task" --require-nonempty --allow README.md >/dev/null 2>&1; then
    echo "out-of-scope patch unexpectedly accepted" >&2; exit 1
  fi
}

case "$mode" in --static) static_check;; --live) static_check; live_check;; *) exit 64;; esac

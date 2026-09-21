#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
RUNNER="$ROOT/scripts/opencode-task.sh"
mode=${1:-}

static_check() {
  grep -Fq 'heartbeat task=' "$RUNNER"
  grep -Fq 'sending TERM' "$RUNNER"
  grep -Fq 'sending KILL' "$RUNNER"
  grep -Fq 'container removal verified' "$RUNNER"
  grep -Fq 'removed expired task state' "$RUNNER"
  grep -Fq 'model-metadata.json' "$RUNNER"
  grep -Fq 'opencode-go/deepseek-v4.1-flash' "$ROOT/dev/opencode/opencode.json"
  grep -Fq '"subagent_depth": 0' "$ROOT/dev/opencode/opencode.json"
  grep -Fq '"share": "disabled"' "$ROOT/dev/opencode/opencode.json"
}

live_check() {
  local source_dir credential_dir project=duegood-lifecycle
  source_dir=$(mktemp -d); credential_dir=$(mktemp -d)
  trap "docker compose -p '$project' -f '$ROOT/dev/opencode/compose.yaml' down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf -- '$source_dir' '$credential_dir'" EXIT
  export DUEGOOD_SOURCE_DIR="$source_dir" DUEGOOD_CREDENTIAL_DIR="$credential_dir"
  local metadata
  metadata=$(docker compose -p "$project" -f "$ROOT/dev/opencode/compose.yaml" run --rm executor --metadata)
  node -e 'const x=JSON.parse(process.argv[1]);if(x.opencodeVersion!=="1.18.30"||x.model!=="opencode-go/deepseek-v4.1-flash"||x.variant!=="high")process.exit(1)' "$metadata"
  docker compose -p "$project" -f "$ROOT/dev/opencode/compose.yaml" run --rm executor sh -c 'echo session > /home/opencode/.local/share/opencode/sentinel; echo cache > /home/opencode/.cache/opencode/sentinel'
  docker compose -p "$project" -f "$ROOT/dev/opencode/compose.yaml" run --rm executor sh -c 'test "$(cat /home/opencode/.local/share/opencode/sentinel)" = session; test "$(cat /home/opencode/.cache/opencode/sentinel)" = cache; test ! -e /workspace/sentinel'
  mkdir -p "$ROOT/.evidence/opencode/tasks/expired"; touch -t 202001010000 "$ROOT/.evidence/opencode/tasks/expired"
  "$RUNNER" cleanup 1
  test ! -e "$ROOT/.evidence/opencode/tasks/expired"
}

case "$mode" in --static) static_check;; --live) static_check; live_check;; *) exit 64;; esac

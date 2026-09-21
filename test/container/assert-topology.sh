#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
COMPOSE="$ROOT/dev/opencode/compose.yaml"
mode=${1:-}

static_check() {
  grep -Fq 'internal: true' "$COMPOSE"
  [[ $(grep -c 'read_only: true' "$COMPOSE") -eq 3 ]]
  [[ $(grep -c 'cap_drop: \[ALL\]' "$COMPOSE") -eq 2 ]]
  [[ $(grep -c 'no-new-privileges:true' "$COMPOSE") -eq 2 ]]
  grep -Fq 'source: ${DUEGOOD_SOURCE_DIR:?set DUEGOOD_SOURCE_DIR}' "$COMPOSE"
  grep -Fq 'source: ${DUEGOOD_CREDENTIAL_DIR:?set DUEGOOD_CREDENTIAL_DIR}' "$COMPOSE"
  grep -Fq 'read_only: false' "$COMPOSE"
  grep -Fq 'target: /credentials' "$COMPOSE"
  grep -Fq 'OPENCODE_DISABLE_DEFAULT_PLUGINS: "1"' "$COMPOSE"
  ! grep -Eqi '(docker\.sock|/Users/|\.ssh|\.aws|\.git[:/]|TOKEN|PASSWORD|API_KEY)' "$COMPOSE"
}

live_check() {
  local source_dir credential_dir project=duegood-topology
  source_dir=$(mktemp -d); credential_dir=$(mktemp -d)
  trap "docker compose -p '$project' -f '$COMPOSE' down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf -- '$source_dir' '$credential_dir'" EXIT
  export DUEGOOD_SOURCE_DIR="$source_dir" DUEGOOD_CREDENTIAL_DIR="$credential_dir"
  docker compose -p "$project" -f "$COMPOSE" up -d proxy
  local cid
  cid=$(docker compose -p "$project" -f "$COMPOSE" run -d executor sh -c 'test ! -e /workspace/.git && sleep 60')
  [[ $(docker inspect -f '{{.Config.User}}' "$cid") == 65532:65532 ]]
  [[ $(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$cid") == true ]]
  [[ $(docker inspect -f '{{json .HostConfig.CapDrop}}' "$cid") == '["ALL"]' ]]
  docker inspect -f '{{json .HostConfig.SecurityOpt}}' "$cid" | grep -Fq 'no-new-privileges:true'
  docker inspect -f '{{json .Mounts}}' "$cid" | grep -Fq '"Destination":"/credentials","Mode":"ro"'
  [[ $(docker inspect -f '{{range .Mounts}}{{if eq .Type "bind"}}{{if eq .RW true}}1{{end}}{{end}}{{end}}' "$cid") == 1 ]]
  [[ $(docker exec "$cid" awk '/^CapEff:/ {print $2}' /proc/1/status) == 0000000000000000 ]]
  docker exec "$cid" grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/1/status
  [[ $(docker exec "$cid" id -G) == 65532 ]]
  docker rm -f "$cid" >/dev/null
}

case "$mode" in --static) static_check;; --live) static_check; live_check;; *) exit 64;; esac

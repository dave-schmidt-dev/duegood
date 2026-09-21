#!/bin/bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
mode=${1:-}
[[ "$mode" == "--credential-free" ]] || { echo "usage: $0 --credential-free" >&2; exit 64; }

status() { printf '[container-gate] %s\n' "$*" >&2; }

status "checking static topology and pinned inputs"
"$ROOT/test/container/assert-topology.sh" --static
"$ROOT/test/container/assert-network.sh" --static
"$ROOT/test/container/assert-lifecycle.sh" --static
"$ROOT/test/container/assert-patch.sh" --static

status "building pinned linux/arm64 executor and proxy images"
export DUEGOOD_SOURCE_DIR="$ROOT" DUEGOOD_CREDENTIAL_DIR="$ROOT/.evidence/opencode/credentials"
mkdir -p "$DUEGOOD_CREDENTIAL_DIR"
docker compose -f "$ROOT/dev/opencode/compose.yaml" build --pull=false proxy executor

status "running live credential-free isolation checks"
"$ROOT/test/container/assert-topology.sh" --live
"$ROOT/test/container/assert-network.sh" --live
"$ROOT/test/container/assert-lifecycle.sh" --live
"$ROOT/test/container/assert-patch.sh" --live
status "credential-free container qualification passed"

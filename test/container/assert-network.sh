#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
COMPOSE="$ROOT/dev/opencode/compose.yaml"
ACL="$ROOT/dev/opencode/proxy-acl.yaml"
mode=${1:-}

static_check() {
  grep -Fq 'action: enforce' "$ACL"
  grep -Fq -- '--disable-acl-policy-action=open' "$ROOT/dev/opencode/proxy.Dockerfile"
  grep -Fq -- '--disable-acl-policy-action=report' "$ROOT/dev/opencode/proxy.Dockerfile"
  grep -Fq 'allowed_domains:' "$ACL"
  grep -Fq 'opencode.ai' "$ACL"
  ! grep -Eq 'action:[[:space:]]*(open|report)' "$ACL"
  grep -Fq 'networks:' "$COMPOSE"
  grep -Fq 'internal: true' "$COMPOSE"
  ! grep -Eqi '(socks|3128|8080|80:|ports:)' "$COMPOSE"
}

live_check() {
  local source_dir credential_dir project=duegood-network
  source_dir=$(mktemp -d); credential_dir=$(mktemp -d)
  trap "docker compose -p '$project' -f '$COMPOSE' down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf -- '$source_dir' '$credential_dir'" EXIT
  export DUEGOOD_SOURCE_DIR="$source_dir" DUEGOOD_CREDENTIAL_DIR="$credential_dir"
  docker compose -p "$project" -f "$COMPOSE" up -d proxy
  local probe='const net=require("net");const [host,port,proxy]=process.argv.slice(1);const s=net.connect(proxy?4750:+port,proxy||host);s.setTimeout(7000);s.on("connect",()=>{if(proxy)s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);else process.exit(0)});let d="";s.on("data",x=>{d+=x;if(d.includes("\r\n")){process.exit(/^HTTP\/1\.[01] 200/.test(d)?0:2)}});s.on("timeout",()=>process.exit(3));s.on("error",()=>process.exit(4));'
  if docker compose -p "$project" -f "$COMPOSE" run --rm --no-deps executor node -e "$probe" 1.1.1.1 443; then
    echo "direct public egress unexpectedly succeeded" >&2; exit 1
  fi
  if ! docker compose -p "$project" -f "$COMPOSE" run --rm executor node -e "$probe" opencode.ai 443 proxy; then
    docker compose -p "$project" -f "$COMPOSE" logs proxy >&2 || true
    echo "allowlisted HTTPS destination was unreachable through the proxy" >&2
    exit 1
  fi
  for target in example.com 127.0.0.1 169.254.169.254 10.0.0.1 172.17.0.1 192.168.0.1 ::1 fc00::1 fe80::1; do
    if docker compose -p "$project" -f "$COMPOSE" run --rm executor node -e "$probe" "$target" 443 proxy; then
      echo "proxy bypass unexpectedly succeeded for $target" >&2; exit 1
    fi
  done
  if docker compose -p "$project" -f "$COMPOSE" run --rm executor node -e "$probe" opencode.ai 80 proxy; then
    echo "non-HTTPS port unexpectedly succeeded" >&2; exit 1
  fi
}

case "$mode" in --static) static_check;; --live) static_check; live_check;; *) exit 64;; esac

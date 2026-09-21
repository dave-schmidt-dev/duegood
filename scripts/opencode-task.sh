#!/bin/bash
set -euo pipefail

umask 077
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
STATE_ROOT=${DUEGOOD_EXECUTOR_STATE_DIR:-"$ROOT/.evidence/opencode"}
COMPOSE="$ROOT/dev/opencode/compose.yaml"
GIT=(git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c diff.external= -c filter.lfs.process= -c filter.lfs.smudge= -c filter.lfs.clean=)

die() { printf 'opencode-task: %s\n' "$*" >&2; exit 1; }
status() { printf '[duegood-executor] %s\n' "$*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }
safe_id() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "invalid identifier"; }

git_safe() {
  env -u GIT_DIR -u GIT_WORK_TREE \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null "${GIT[@]}" -C "$ROOT" "$@"
}

task_git() {
  local task_dir=$1
  shift
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    GIT_INDEX_FILE="${GIT_INDEX_FILE:-$task_dir/index}" \
    GIT_OBJECT_DIRECTORY="$task_dir/objects" \
    GIT_ALTERNATE_OBJECT_DIRECTORIES="$ROOT/.git/objects" \
    "${GIT[@]}" -C "$ROOT" "$@"
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

prepare_source() {
  local task_id=$1
  shift
  local task_dir="$STATE_ROOT/tasks/$task_id"
  local index_file="$task_dir/index"
  local source_dir="$task_dir/source"
  mkdir -p "$task_dir/objects"
  [[ ! -e "$source_dir" ]] || die "task source already exists: $task_id"
  GIT_INDEX_FILE="$index_file" task_git "$task_dir" read-tree HEAD
  while (($#)); do
    [[ "$1" != /* && "$1" != *..* ]] || die "unsafe included path: $1"
    GIT_INDEX_FILE="$index_file" task_git "$task_dir" add -- "$1"
    shift
  done
  local tree_oid
  tree_oid=$(GIT_INDEX_FILE="$index_file" task_git "$task_dir" write-tree)
  mkdir "$source_dir"
  task_git "$task_dir" archive "$tree_oid" | tar -x -C "$source_dir" --no-same-owner --no-same-permissions
  [[ ! -e "$source_dir/.git" ]] || die "source archive unexpectedly contains Git metadata"
  printf '%s\n' "$tree_oid" >"$task_dir/baseline-tree"
  printf '%s\n' "$tree_oid"
}

write_receipt() {
  local task_id=$1 status_value=$2 metadata_file=$3 patch_file=$4
  local task_dir="$STATE_ROOT/tasks/$task_id"
  node - "$task_id" "$status_value" "$task_dir/baseline-tree" "$metadata_file" "$patch_file" <<'NODE'
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const [taskId, status, baselinePath, metadataPath, patchPath] = process.argv.slice(2);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const metadataBytes = readFileSync(metadataPath);
const patchBytes = readFileSync(patchPath);
const receipt = {
  schemaVersion: 1,
  taskId,
  status,
  baselineTree: readFileSync(baselinePath, "utf8").trim(),
  executorImage: "duegood-opencode:1.18.30",
  proxySourceRevision: "609eb8931420453daf5893509be0b25b21bd9edb",
  modelMetadata: JSON.parse(metadataBytes),
  modelMetadataSha256: hash(metadataBytes),
  patchSha256: hash(patchBytes),
  environment: {
    networkPolicy: "smokescreen-enforce-https-allowlist",
    sourceHasGitMetadata: false,
    credentialsReadOnly: true,
  },
};
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
NODE
}

run_task() {
  local task_id=$1 deadline=$2
  shift 2
  local task_dir="$STATE_ROOT/tasks/$task_id"
  local source_dir="$task_dir/source"
  [[ -d "$source_dir" ]] || die "prepare task source first"
  [[ -d "$STATE_ROOT/credentials" ]] || mkdir -p "$STATE_ROOT/credentials"
  local project="duegood-${task_id//[^A-Za-z0-9]/-}"
  local start now container_id=""
  start=$(date +%s)
  export DUEGOOD_SOURCE_DIR="$source_dir" DUEGOOD_CREDENTIAL_DIR="$STATE_ROOT/credentials" COMPOSE_PROJECT_NAME="$project"
  status "starting $task_id with ${deadline}s deadline"
  docker compose -f "$COMPOSE" up -d proxy >/dev/null
  docker compose -f "$COMPOSE" run -d --name "${project}-executor" executor "$@" >"$task_dir/container-id"
  container_id=$(tr -d '\r\n' <"$task_dir/container-id")
  trap 'docker rm -f "$container_id" >/dev/null 2>&1 || true' RETURN
  while docker inspect -f '{{.State.Running}}' "$container_id" 2>/dev/null | grep -qx true; do
    now=$(date +%s)
    if ((now - start >= deadline)); then
      status "deadline reached; sending TERM"
      docker kill --signal TERM "$container_id" >/dev/null 2>&1 || true
      for _ in 1 2 3 4 5; do
        docker inspect -f '{{.State.Running}}' "$container_id" 2>/dev/null | grep -qx true || break
        sleep 1
      done
      if docker inspect -f '{{.State.Running}}' "$container_id" 2>/dev/null | grep -qx true; then
        status "grace period expired; sending KILL"
        docker kill --signal KILL "$container_id" >/dev/null 2>&1 || true
      fi
      die "task deadline exceeded"
    fi
    status "heartbeat task=$task_id elapsed=$((now - start))s"
    sleep 5
  done
  local exit_code
  exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$container_id")
  docker logs "$container_id" >"$task_dir/stdout.log" 2>"$task_dir/stderr.log"
  docker compose -f "$COMPOSE" run --rm executor --metadata >"$task_dir/model-metadata.json"
  docker rm "$container_id" >/dev/null
  container_id=""
  docker compose -f "$COMPOSE" down --remove-orphans >/dev/null
  ((exit_code == 0)) || die "executor exited $exit_code"
  status "task $task_id stopped and container removal verified"
}

export_patch() {
  local task_id=$1 require_nonempty=$2
  shift 2
  local task_dir="$STATE_ROOT/tasks/$task_id" source_dir="$STATE_ROOT/tasks/$task_id/source"
  local baseline
  baseline=$(<"$task_dir/baseline-tree")
  local clean_index="$task_dir/export-index"
  rm -f -- "$clean_index"
  GIT_INDEX_FILE="$clean_index" task_git "$task_dir" --git-dir="$ROOT/.git" --work-tree="$source_dir" read-tree "$baseline"
  GIT_INDEX_FILE="$clean_index" task_git "$task_dir" --git-dir="$ROOT/.git" --work-tree="$source_dir" add -A -- .
  local new_tree
  new_tree=$(GIT_INDEX_FILE="$clean_index" task_git "$task_dir" --git-dir="$ROOT/.git" --work-tree="$source_dir" write-tree)
  local changed
  changed=$(task_git "$task_dir" diff-tree --no-commit-id --name-only -r "$baseline" "$new_tree")
  if [[ "$require_nonempty" == 1 && -z "$changed" ]]; then die "required patch is empty"; fi
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    [[ "$path" != /* && "$path" != *../* && "$path" != .git && "$path" != .git/* ]] || die "unsafe changed path"
    local allowed=0 candidate
    for candidate in "$@"; do [[ "$path" == "$candidate" ]] && allowed=1; done
    ((allowed == 1)) || die "out-of-scope path: $path"
  done <<<"$changed"
  local entry metadata mode type oid path
  while IFS= read -r -d '' entry; do
    metadata=${entry%%$'\t'*}
    path=${entry#*$'\t'}
    IFS=' ' read -r mode type oid <<<"$metadata"
    [[ "$mode" == 100644 || "$mode" == 100755 ]] || die "prohibited file mode $mode at $path"
    [[ "$type" == blob ]] || die "prohibited object type $type at $path"
  done < <(task_git "$task_dir" ls-tree -rz "$new_tree")
  task_git "$task_dir" diff --binary --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ "$baseline" "$new_tree" >"$task_dir/patch.diff"
  grep -Eq '^diff --git a/[^ ]+ b/[^ ]+$' "$task_dir/patch.diff" || [[ "$require_nonempty" == 0 ]] || die "unsafe or missing patch headers"
  printf '%s\n' "$new_tree" >"$task_dir/result-tree"
  printf '%s\n' "$task_dir/patch.diff"
}

cleanup() {
  local max_age=${1:-604800} now mtime path
  [[ "$max_age" =~ ^[0-9]+$ ]] || die "cleanup age must be seconds"
  now=$(date +%s)
  [[ -d "$STATE_ROOT/tasks" ]] || return 0
  for path in "$STATE_ROOT"/tasks/*; do
    [[ -d "$path" ]] || continue
    mtime=$(stat -f %m "$path" 2>/dev/null || stat -c %Y "$path")
    if ((now - mtime > max_age)); then
      rm -rf -- "$path"
      status "removed expired task state $(basename "$path")"
    fi
  done
}

usage() {
  echo "usage: $0 prepare TASK [--include PATH ...] | run TASK DEADLINE_SECONDS COMMAND... | export-patch TASK --require-nonempty --allow PATH... | receipt TASK STATUS | cleanup [MAX_AGE_SECONDS]" >&2
  exit 64
}

need git; need node; need shasum
cmd=${1:-}; shift || true
case "$cmd" in
  prepare)
    task=${1:-}; [[ -n "$task" ]] || usage; safe_id "$task"; shift
    includes=(); while (($#)); do [[ "$1" == --include && $# -ge 2 ]] || usage; includes+=("$2"); shift 2; done
    if ((${#includes[@]})); then prepare_source "$task" "${includes[@]}"; else prepare_source "$task"; fi
    ;;
  run)
    task=${1:-}; deadline=${2:-}; [[ -n "$task" && "$deadline" =~ ^[1-9][0-9]*$ && $# -ge 3 ]] || usage
    safe_id "$task"; shift 2; need docker; run_task "$task" "$deadline" "$@"
    ;;
  export-patch)
    task=${1:-}; [[ -n "$task" ]] || usage; safe_id "$task"; shift
    require=0; allowed=(); while (($#)); do case "$1" in --require-nonempty) require=1; shift;; --allow) [[ $# -ge 2 ]] || usage; allowed+=("$2"); shift 2;; *) usage;; esac; done
    ((${#allowed[@]} > 0)) || die "at least one allowed path is required"
    export_patch "$task" "$require" "${allowed[@]}"
    ;;
  receipt)
    task=${1:-}; result=${2:-}; [[ -n "$task" && "$result" =~ ^(done|failed|blocked)$ ]] || usage; safe_id "$task"
    write_receipt "$task" "$result" "$STATE_ROOT/tasks/$task/model-metadata.json" "$STATE_ROOT/tasks/$task/patch.diff" >"$STATE_ROOT/tasks/$task/receipt.json"
    printf '%s\n' "$STATE_ROOT/tasks/$task/receipt.json"
    ;;
  cleanup) cleanup "${1:-604800}" ;;
  *) usage ;;
esac

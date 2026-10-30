#!/usr/bin/env bash
# Validate a worktree before handoff or push.
#
# Fails if the tree is dirty before or after validation, catching generated
# drift from build/check commands.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

run_step() {
  local label="$1"
  shift

  echo "==> ${label}"
  "$@"
}

assert_clean_worktree() {
  local phase="$1"
  local status

  status="$(git status --short)"
  if [[ -n "$status" ]]; then
    echo "worktree is not clean ${phase}:"
    echo "$status"
    exit 1
  fi
}

assert_clean_worktree "before validation"
run_step "lint" pnpm run lint
run_step "format check" pnpm run format:check
run_step "typecheck" pnpm run typecheck
run_step "test" pnpm run test
run_step "build" pnpm run build

assert_clean_worktree "after validation"
echo "worktree validation passed"

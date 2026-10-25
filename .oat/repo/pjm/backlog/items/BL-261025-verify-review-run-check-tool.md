---
id: BL-261025-verify-review-run-check-tool
title: Verify-review run_check tool bridge
status: open
priority: medium
scope: feature
scope_estimate: L
labels:
  - review
assignee: null
created: 2026-10-25T05:50:35.879Z
updated: 2026-10-25T05:50:35.879Z
associated_issues: []
external_plans: []
---

## Description

Project agent-ci-v1 phase p04. A `run_check` tool bridge so the reviewer can run repository checks in a controlled environment (env allowlist that strips tokens, PATH excluding the checkout, recorded evidence IDs findings cite). Settle MCP server vs OpenCode plugin.

## Acceptance Criteria

- A `run_check` tool bridge runs repository checks with an env allowlist that strips tokens and a PATH that excludes the checkout, and records evidence IDs that findings cite
- Bridge and controlled-environment tests pass
- One live verify-review run on a test PR in `tkstang/agent-ci` is recorded in the journal

## Progress

- 2026-10-25 (agent-ci-v1 p04, branch `feat/agent-ci-v1`, not merged): verify-review implemented. The checks are named commands in `.github/agent-ci/checks.yaml`, read from the base commit. They run only where no model credential exists: the credential-free `verify` job in `pr-review.yml` (`verify` input, default off), or before the reviewer starts for `agent-ci review run --verify`. Each check runs in a fresh copy with an environment allowlist, a PATH without checkout entries, a deadline, a 1 MiB output cap and a process-group kill, isolated by Linux namespaces or macOS sandbox-exec. Results go to `checks.json` with hash evidence IDs. The `run_check` bridge is agent-ci's stdio MCP server (Claude and Codex; OpenCode and Cursor are refused). The findings gate checks citations against each pass's validated copy. Live: a local Claude Haiku run published review 5644625253 on test PR #21, and the `pull_request` self-test run 40220961692 published review 5644640602 with check evidence. Decisions: DR-261025-bridge-verify-review-run-check and DR-261025-run-verify-review-checks-where. Stays open until phase acceptance.

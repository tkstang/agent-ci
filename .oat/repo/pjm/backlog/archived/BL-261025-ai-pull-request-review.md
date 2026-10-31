---
id: BL-261025-ai-pull-request-review
title: AI pull-request review workflow
status: closed
priority: high
scope: feature
scope_estimate: XL
labels:
  - review
  - workflows
assignee: null
created: 2026-10-25T05:50:35.678Z
updated: '2026-10-25T20:27:30Z'
associated_issues: []
external_plans: []
---

## Description

Project agent-ci-v1 phase p03. Trigger by label, comment or dispatch behind a permission gate; one or two reviewer passes with schema-constrained output where the harness supports it; a deterministic findings gate (re-read cited source, quote hashes, diff positions); optional adjudicator on harnesses with a verified tool lockdown; one published PR review plus an updatable summary comment. Fork PRs never receive model credentials.

## Acceptance Criteria

- Trigger by label, comment or dispatch behind a permission gate (requester has write/admin; fork PRs never get model credentials or run the agent)
- Unit tests pass for the permission gate, the deterministic findings gate (re-read cited source, quote hashes, diff positions), rendering and publishing
- A live review of a test PR in `tkstang/agent-ci` with a cheap model publishes one PR review with inline comments plus an updatable summary comment, recorded in the journal

## Progress

- 2026-10-25 (agent-ci-v1 p03, branch `feat/agent-ci-v1`, not merged): `pr-review.yml` and `agent-ci review` stages implemented (gate, prepare, pass, sources, adjudicate, findings, publish, local `run`); consumer template `consumer-workflows/agent-ci-pr-review.yml`. Live: a local `agent-ci review run` with `claude-haiku-4-5` (pool) published one inline review with two findings and the summary on test PR #9, and its rerun posted nothing new; the `pull_request` self-test with the fake harness ran every job and published (runs 40195270652 and 40195460485). Decisions: DR-261025-trigger-pr-reviews-from, DR-261025-run-the-pr-review-adjudicator. Stays open until phase acceptance; `verify-review` is BL-261025-verify-review-run-check-tool.

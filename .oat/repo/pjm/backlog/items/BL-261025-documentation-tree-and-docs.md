---
id: BL-261025-documentation-tree-and-docs
title: Documentation tree and docs check
status: open
priority: medium
scope: task
scope_estimate: M
labels:
  - docs
assignee: null
created: 2026-10-25T05:50:36.283Z
updated: 2026-10-25T20:30:00.000Z
associated_issues: []
external_plans: []
---

## Description

Project agent-ci-v1 phase p06. `docs/` Markdown tree via OAT docs bootstrap conventions (getting started, harnesses and routing, workflows, PR review, configuration, security model), a `pnpm docs:check` index/link check, README and current-state refresh.

## Acceptance Criteria

- A `docs/` Markdown tree created through the OAT docs bootstrap conventions covers getting started, harnesses and routing, workflows, PR review, configuration and the security model
- `pnpm docs:check` (docs index and internal links) passes
- README and `pjm/current-state.md` reflect shipped capability

## Progress

- 2026-10-25 (agent-ci-v1 p06, branch `feat/agent-ci-v1`, not merged): `docs/` bootstrapped with `oat docs init` (plain Markdown, flat-small; DR-261025-organize-the-docs-as-one-flat) with seven reader pages: getting started, harnesses and routing, workflows, PR review, configuration and credentials, using agent-ci from another repository, security model. `pnpm docs:check` (`src/docs-check/`, run in CI) checks directory indexes, Contents completeness, page metadata, and relative links and anchors in `docs/`, `README.md` and `AGENTS.md`. README and `pjm/current-state.md` rewritten for the shipped capability. Stays open until phase acceptance.

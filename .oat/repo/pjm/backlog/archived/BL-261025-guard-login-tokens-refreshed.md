---
id: BL-261025-guard-login-tokens-refreshed
title: Guard login tokens refreshed during a run
status: closed
priority: low
scope: task
scope_estimate: S
labels:
  - security
  - harness
assignee: null
created: 2026-10-25T06:35:14.224Z
updated: '2026-10-25T06:53:33Z'
associated_issues: []
external_plans: []
---

## Description

Re-read seeded login stores (Codex auth.json, Claude .credentials.json, OpenCode auth store) after attempts and before the final secret check so tokens refreshed mid-run are guarded. Source: p01 review round 2 L1 (agent-ci-v1). Trigger: before any CI route uses login: true.

## Acceptance Criteria

- {Outcome 1}
- {Outcome 2}

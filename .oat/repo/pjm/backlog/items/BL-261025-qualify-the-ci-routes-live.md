---
id: BL-261025-qualify-the-ci-routes-live
title: Qualify the CI routes live
status: open
priority: medium
scope: task
scope_estimate: S
labels:
  - routing
assignee: null
created: 2026-10-25T05:50:36.688Z
updated: 2026-10-25T05:50:36.688Z
associated_issues: []
external_plans: []
---

## Description

models.yaml marks `claude-haiku-4-5-personal` (CLAUDE_CODE_OAUTH_TOKEN), `grok-4.7-opencode` (OPENCODE_API_KEY), `claude-haiku-5-5-pool` and `glm-5.3-flash-opencode-login` as `qualified: null`. Qualify each with one cheap live `agent-ci run` once the credential exists, and record the date.

## Acceptance Criteria

- {Outcome 1}
- {Outcome 2}

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
updated: 2026-10-25T09:10:00.000Z
associated_issues: []
external_plans: []
---

## Description

models.yaml marks `claude-haiku-4-5-personal` (CLAUDE_CODE_OAUTH_TOKEN), `grok-4.7-opencode` (OPENCODE_API_KEY), `claude-haiku-5-5-pool` and `glm-5.3-flash-opencode-login` as `qualified: null`. Qualify each with one cheap live `agent-ci run` once the credential exists, and record the date.

## Acceptance Criteria

- Each route marked `qualified: null` in `models.yaml` (`claude-haiku-4-5-personal`, `grok-4.7-opencode`, `claude-haiku-5-5-pool`, `glm-5.3-flash-opencode-login`) gets one cheap live `agent-ci run` producing a validated `run-result.json`, or is removed
- `qualified` holds the date of that run, and the journal records the auth source and account used

## Progress

- 2026-10-25 (p02-t11): `claude-haiku-5-5-pool` (pool, `--allow-pool`) and `glm-5.3-flash-opencode-login` (personal, `--seed-login`) each passed one live read-only `agent-ci run` with a validated `run-result.json`; `qualified` is now `2026-10-25`.
- Still open: `claude-haiku-4-5-personal` (needs `CLAUDE_CODE_OAUTH_TOKEN`) and `grok-4.7-opencode` (needs `OPENCODE_API_KEY`). Neither credential exists locally or as a repository secret, and the agent does not create credentials. Qualify each once the operator provides the credential (locally, or as a repository secret for a model-backed Actions run of `run-agent.yml`).

---
id: BL-261025-codex-chatgpt-login-route
title: Codex ChatGPT-login route for the private fleet
status: open
priority: medium
scope: task
scope_estimate: M
labels:
  - routing
  - codex
  - ci
assignee: null
created: 2026-10-25T22:20:20.892Z
updated: 2026-10-25T22:20:20.892Z
associated_issues: []
external_plans: []
---

## Description

OpenAI documents ChatGPT-login CI as an advanced workflow for trusted private automation: one auth.json per runner, never shared across concurrent jobs; API keys remain recommended. Add a Codex route that uses an auth.json kept on the self-hosted runner's disk (not a GitHub secret: the refresh token rotates), serialize jobs that use it (concurrency group or max-parallel 1 in fan-out), extend the refreshed-login secret guard to it, and refuse it on GitHub-hosted runners and the public fleet.

## Acceptance Criteria

- A Codex route using a runner-local `auth.json` is refused on GitHub-hosted runners and needs explicit opt-in
- Jobs using it are serialized (no two concurrent jobs share the login)
- Tokens refreshed during a run are guarded like other login routes
- One live run on the private fleet's runner is recorded, and the docs cite OpenAI's guidance


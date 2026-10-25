---
id: BL-261025-live-verify-opencode-read-only
title: Live-verify OpenCode read-only deny rules
status: open
priority: medium
scope: task
scope_estimate: S
labels:
  - harness
  - security
assignee: null
created: 2026-10-25T05:50:36.487Z
updated: 2026-10-25T05:50:36.487Z
associated_issues: []
external_plans: []
---

## Description

The opencode adapter writes `permission: {edit: deny, bash: deny, webfetch: deny}` into the isolated config for read-only runs and sets OPENCODE_DISABLE_PROJECT_CONFIG=1. OpenCode v2 accepted the config without validation errors, but no live run has proven an edit or shell attempt is denied. Run one cheap read-only opencode prompt that asks for a file write and confirm the file is not created; adjust keys if v2 renamed them (v2 docs list a `shell` action).

## Acceptance Criteria

- {Outcome 1}
- {Outcome 2}

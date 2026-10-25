---
id: BL-261025-live-verify-opencode-read-only
title: Live-verify OpenCode read-only deny rules
status: closed
priority: medium
scope: task
scope_estimate: S
labels:
  - harness
  - security
assignee: null
created: 2026-10-25T05:50:36.487Z
updated: '2026-10-25T06:26:14Z'
associated_issues: []
external_plans: []
---

## Description

The opencode adapter writes `permission: {edit: deny, bash: deny, webfetch: deny}` into the isolated config for read-only runs and sets OPENCODE_DISABLE_PROJECT_CONFIG=1. OpenCode v2 accepted the config without validation errors, but no live run has proven an edit or shell attempt is denied. Run one cheap read-only opencode prompt that asks for a file write and confirm the file is not created; adjust keys if v2 renamed them (v2 docs list a `shell` action).

## Acceptance Criteria

- A cheap read-only `opencode run` (isolated home, stdin closed, `--standalone`) asked to write a file and run a shell command produces neither, while a control run without deny rules does
- The adapter's read-only deny keys match OpenCode v2 (deny both `bash` and `shell` if accepted) and the result is recorded in project research

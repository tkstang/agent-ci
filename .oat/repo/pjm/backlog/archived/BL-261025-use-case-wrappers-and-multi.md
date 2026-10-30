---
id: BL-261025-use-case-wrappers-and-multi
title: Use-case wrappers and multi-repo fan-out
status: closed
priority: medium
scope: feature
scope_estimate: M
labels:
  - workflows
assignee: null
created: 2026-10-25T05:50:36.081Z
updated: '2026-10-25T20:27:30Z'
associated_issues: []
external_plans: []
---

## Description

Project agent-ci-v1 phase p05. Docs-update, instructions-update and tools-update workflows, and a multi-repository fan-out driven by `targets.yaml`.

## Acceptance Criteria

- Docs-update, instructions-update and tools-update workflows exist as thin callers of `run-agent.yml`
- A multi-repository fan-out is driven by `targets.yaml`
- Wrapper and fan-out workflow tests and `actionlint` pass

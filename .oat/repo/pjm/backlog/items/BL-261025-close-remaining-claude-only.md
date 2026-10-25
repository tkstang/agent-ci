---
id: BL-261025-close-remaining-claude-only
title: Close remaining Claude-only policy name-check gaps
status: open
priority: low
scope: task
scope_estimate: XS
labels:
  - policy
  - routing
assignee: null
created: 2026-10-25T06:35:14.453Z
updated: 2026-10-25T06:35:14.453Z
associated_issues: []
external_plans: []
---

## Description

Name check misses separator-less IDs (sonnet4.5) and a Cursor auto route can select Claude. The family field is the primary guard. Source: p01 review round 2 L3 (agent-ci-v1). Trigger: before adding a Cursor auto or unseparated Claude-like route.

## Acceptance Criteria

- {Outcome 1}
- {Outcome 2}

---
id: BL-261030-make-the-moved-base-publish
title: Make the moved-base publish test deterministic
status: open
priority: medium
scope: task
scope_estimate: S
labels:
  - test
  - flaky
assignee: null
created: 2026-10-30T19:23:49.597Z
updated: 2026-10-30T19:23:49.597Z
associated_issues: []
external_plans: []
---

## Description

src/publish/publish.test.ts "records a moved base, then refuses an older base that would undo it" fails about 1 in 10 runs. It is pre-existing on main (seen 2026-10-28 while working on PR #29), so CI can fail on unrelated changes.

## Acceptance Criteria

- The timing or ordering dependency behind the intermittent failure is identified and recorded.
- The test passes 100 consecutive local runs with no change to the behavior it protects.

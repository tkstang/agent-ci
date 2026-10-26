---
id: BL-261025-self-hosted-runner-and-proxy
title: Self-hosted runner and proxy readiness
status: open
priority: medium
scope: task
scope_estimate: S
labels:
  - runners
  - proxy
  - release
assignee: null
created: 2026-10-25T22:20:21.268Z
updated: 2026-10-25T22:20:21.268Z
associated_issues: []
external_plans: []
---

## Description

Make the proxy base URL configurable per runner (models.yaml uses 127.0.0.1:8317, unreachable from a containerized or VM runner), run the first live private-fleet job on a registered tkstang/actions-runner runner with allow_pool, and publish a release tag so consumer templates can pin a tag instead of @main.

## Acceptance Criteria

- The proxy base URL for pool routes can be set per runner without editing `models.yaml`
- One live `allow_pool` job runs on a registered self-hosted runner and is recorded
- A release tag exists and the consumer templates show pinning it (or a SHA)


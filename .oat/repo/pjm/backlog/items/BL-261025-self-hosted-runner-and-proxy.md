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
updated: 2026-10-30T21:00:00.000Z
associated_issues: []
external_plans: []
---

## Description

Make the proxy base URL configurable per runner (models.yaml uses 127.0.0.1:8317, unreachable from a containerized or VM runner), run the first live private-fleet job on a registered tkstang/actions-runner runner with allow_pool, and publish a release tag so consumer templates can pin a tag instead of @main.

## Acceptance Criteria

- The proxy base URL for pool routes can be set per runner without editing `models.yaml`
- One live `allow_pool` job runs on a registered self-hosted runner and is recorded
- A release tag exists and the consumer templates show pinning it (or a SHA)

## Progress

- 2026-10-28 (PR #29): criterion 1 met in a different form. An optional `AGENT_CI_PROXY_BASE_URL` secret (an environment variable locally) replaces the loopback origin of every pool route without editing `models.yaml`. It is set per calling repository or fleet rather than per runner; each route keeps its own path. The private fleet passes it through (2026-10-30).
- Still open: criterion 2 (runner admission in `tkstang/actions-runner` is pending the operator's approval on the host) and criterion 3 (no release tag; the private fleet pins a commit SHA).

- 2026-10-31: JSON label-array support is prepared across reusable workflows;
  single-label inputs and hosted defaults remain compatible. The
  [qualification packet](../reviews/runner-proxy-readiness.md) records source
  pins, the fleet/workflow/job/event admission gaps, guest qualification,
  separately gated external PRs and the proposed versioned release. No live
  acceptance, credential change, external mutation or release is claimed.

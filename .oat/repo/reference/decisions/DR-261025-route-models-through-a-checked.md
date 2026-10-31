---
id: DR-261025-route-models-through-a-checked
title: Route models through a checked-in models.yaml with an enforced policy
date: 2026-10-25
status: accepted
legacy_id: null
---

# Route models through a checked-in models.yaml with an enforced policy

## Context

A caller picks a model; agent-ci must choose the harness, credential and account. The local proxy cannot enforce per-key rules, and a listed model is not a qualified route.

## Decision

`models.yaml` maps each qualified model to routes (harness, provider model, credential env names, billing class, account personal|work|pool, structured-output mode, qualification date). Policy in `src/routing/policy.ts`: Claude models only on the claude harness; no automatic fallback from subscription to paid-api billing or into account class `work` (paid or `work` routes are chosen only explicitly); `pool` routes need `--allow-pool` and are always refused when CI or GITHUB_ACTIONS is set; login-seeded routes are local only. Every harness child gets an environment built from an allowlist plus only the route's named credentials, and an isolated per-run home root.

## Consequences

Live catalog discovery is not the source of truth. Adding a model means adding a route and qualifying it live. The isolated home root was verified live on 2026-10-25: with an empty root and no route credential all four harnesses failed authentication.

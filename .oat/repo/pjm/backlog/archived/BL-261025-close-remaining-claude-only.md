---
id: BL-261025-close-remaining-claude-only
title: Close remaining Claude-only policy name-check gaps
status: closed
priority: low
scope: task
scope_estimate: XS
labels:
  - policy
  - routing
assignee: null
created: 2026-10-25T06:35:14.453Z
updated: '2026-10-31T20:37:43Z'
associated_issues: []
external_plans: []
---

## Description

Name check misses separator-less IDs (sonnet4.5) and a Cursor auto route can select Claude. The family field is the primary guard. Source: p01 review round 2 L3 (agent-ci-v1). Trigger: before adding a Cursor auto or unseparated Claude-like route.

## Acceptance Criteria

- A route whose model key or provider ID is a separator-less Claude-like name (for example `sonnet4.5`, `opus41`, `haiku4`) on a non-claude harness is rejected at load time with `E_POLICY_HARNESS` even when it declares a non-Claude `family`, covered by a `src/routing/resolve.test.ts` case per name
- A Cursor route whose provider model lets Cursor choose the model (`auto`, `auto-smart`, `default`, or any parameterized auto router) is either rejected at load time (`E_POLICY_HARNESS` or `E_ROUTE_CONFIG`) or requires an explicit, documented policy decision recorded under `reference/decisions/`, with a test asserting the chosen behaviour
- The existing non-Claude control (`grok-4.7-cursor`, `family: xai`, provider model `grok-4.7-low`) still loads and resolves

## Delivery evidence

- Load-time guards cover all required short names independently in model keys
  and provider IDs, falsely declared families, and Cursor automatic selector
  case/whitespace/parameter variants. Explicit Grok selection and the
  self-hosted/opt-in Claude Code pool controls remain accepted.
- The new regression selection failed in 21 cases before the policy fix
  because invalid routes loaded successfully. Both positive controls passed.
  After the fix, all 56 routing tests pass.
- Typecheck, focused lint/format, docs and agent checks passed. Archived in
  the implementation delivery; merge remains subject to operator approval.

---
id: BL-261110-let-a-fleet-add-its-own-pool
title: Let a fleet add its own pool routes
status: open
priority: low
scope: feature
scope_estimate: M
labels:
  - routing
  - fleet
assignee: null
created: 2026-11-10T00:14:50.363Z
updated: 2026-11-10T00:14:50.363Z
associated_issues:
  - https://github.com/tkstang/agent-ci/issues/16
external_plans: []
---

## Description

Pool routes are fixed catalog entries in models.yaml, and AGENT_CI_PROXY_BASE_URL sends every pool route to one origin. A fleet that runs its own proxy or Anthropic/OpenAI-compatible endpoint can reuse the catalog's pool routes, but cannot declare routes for its endpoint, send different models to different endpoints, or label an endpoint's real billing. Because pool routes are always labelled subscription, pointing the pool origin at a metered endpoint would bypass the no-paid-fallback guard (E_POLICY_FALLBACK). Let a caller declare additional routes for models and harnesses agent-ci already supports, each with its own https origin, credential secret name and honest billing label, resolved under the same policy. Models outside the catalog (for example Llama) are out of scope for now. Related: allowing pool routes on GitHub-hosted runners when the origin is https is tracked separately.

## Acceptance Criteria

- A fleet caller can declare extra routes for catalog models and supported harnesses, each with its own https origin, credential secret name and billing label (`subscription` or `paid-api`).
- Caller-declared routes resolve under the same policy as catalog routes: pool opt-in and runner rules, credential isolation, Claude only through Claude Code, and `E_POLICY_FALLBACK` when a `paid-api` route would follow a skipped `subscription` route.
- `agent-ci targets validate` checks caller-declared routes, and invalid routes are refused before any job that runs code or an agent.
- Docs show how to point a fleet at your own proxy or compatible endpoint, including how to label metered billing honestly.
- Models outside the catalog remain unsupported, and the docs say so.

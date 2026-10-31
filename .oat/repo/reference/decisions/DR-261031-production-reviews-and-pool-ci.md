---
id: DR-261031-production-reviews-and-pool-ci
title: Production reviews and pool CI
date: 2026-10-31
status: accepted
legacy_id: null
---

# Production reviews and pool CI

## Context

The current Haiku/Grok defaults were cheap test choices. On 2026-10-31 the operator selected Sol 6.1 High primary review, optional Opus 5.5 High second review, and Sol 6.1 Low adjudication, then activated a delivery goal. The operator explicitly reversed DR-261025-keep-claude-pool-routes, which refused Claude pool routes in CI.

## Decision

Use effort-specific catalog keys gpt-6.1-sol-high and gpt-6.1-sol-low with provider model gpt-6.1-sol, and claude-opus-5-5-high with provider model claude-opus-5-5. Reusable workflow defaults enable the primary reviewer only; the operator's callers should enable primary plus adjudicator, with the second reviewer on request. Permit Claude subscription-pool routes through Claude Code in CI on an explicitly opted-in self-hosted runner. This replaces the Claude-family CI refusal in DR-261025-keep-claude-pool-routes and the corresponding CI restriction in DR-261025-use-the-local-proxy-pool. Keep all other billing, harness, runner and opt-in boundaries.

## Consequences

Forward route effort through the relevant harness and wire ANTHROPIC_AUTH_TOKEN through static workflow secret chains; callers may map their existing AGENT_CI_PROXY_API_KEY explicitly, without creating another credential. New routes remain unqualified until live checks succeed. Keep pool opt-in disabled by default and document the required self-hosted caller setup. Never fall back to paid billing or use CODEX_OPENAI_API_KEY. Sol adjudication is a desired outcome, not an implemented capability: pinned Codex0.163.0 exposes no verified global zero-tool CLI configuration. Preserve supportsNoTools:false and existing adjudicator protections until a separately approved and verified tool-free transport exists; the direct subscription-pool Responses alternative is awaiting the operator's choice. DR-261025-run-the-pr-review-adjudicator remains the current execution guarantee until that transport decision is settled.

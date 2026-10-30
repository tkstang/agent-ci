---
id: DR-261025-keep-claude-pool-routes
title: Keep Claude pool routes refused in CI
date: 2026-10-25
status: accepted
legacy_id: null
---

# Keep Claude pool routes refused in CI

## Context

DR-261025-use-the-local-proxy-pool and its 2026-10-25 amendment let non-Claude proxy-pool routes run in CI on a self-hosted runner with an explicit allow_pool opt-in, but left Claude pool routes refused under CI behind CI_POOL_ALLOWS_CLAUDE = false in src/routing/policy.ts, pending an operator decision, including whether to key the rule to billing instead of model family. The final review also noted that flipping the constant alone would not let a Claude pool route run, because ANTHROPIC_AUTH_TOKEN is not in WORKFLOW_MODEL_SECRETS or any workflow credential chain.

## Decision

The operator decided on 2026-10-25 (agent-ci-v1) to keep Claude pool routes refused in CI as implemented. Claude is not routed through the CLIProxyAPI pool in CI. checkPoolPolicy keeps refusing Claude-family pool routes under CI with E_POLICY_POOL_CI, independent of key or billing label, and no billing-keyed rule is added.

## Consequences

CI_POOL_ALLOWS_CLAUDE stays false and ANTHROPIC_AUTH_TOKEN stays out of every workflow. Claude in CI uses a personal CLAUDE_CODE_OAUTH_TOKEN (route claude-haiku-4-5-personal, not yet qualified live) or an API key. Non-Claude pool routes such as gpt-5.6-luna-pool remain available on self-hosted runners with allow_pool. Reopening this needs a new decision plus the workflow and secret-list changes recorded in the proxy-pool DR's final-review note.

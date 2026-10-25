---
id: DR-261025-use-the-local-proxy-pool
title: Use the local proxy pool for Claude only in local runs
date: 2026-10-25
status: accepted
legacy_id: null
---

# Use the local proxy pool for Claude only in local runs

## Context

The operator routes Claude through CLIProxyAPI today and approved a few cheap local calls on each subscription, including the employer account, on 2026-10-25. Pooling subscription credentials raises terms questions in unattended CI.

## Decision

Claude pool routes carry `account: pool`; they run only locally with `--allow-pool` and are refused whenever CI or GITHUB_ACTIONS is set. CI routes use a personal `CLAUDE_CODE_OAUTH_TOKEN` or an API key, never the pool.

## Consequences

Local end-to-end, publish and review runs in p01-p04 may use the pool with cheap models only.

## Amendment 2026-10-25: non-Claude pool routes on self-hosted runners

The operator asked on 2026-10-25 why CI refused the proxy outright; this decision was meant to cover Claude only. The policy now lives in one function, `checkPoolPolicy` in `src/routing/policy.ts`:

- Every pool route still needs an explicit opt-in: `--allow-pool` locally, or the `allow_pool` workflow input (default false) on `run-agent.yml`, `pr-review.yml`, `fan-out.yml` and the docs and instructions wrappers.
- Under CI, a non-Claude pool route is allowed only on a self-hosted runner (`RUNNER_ENVIRONMENT=self-hosted`), whose host serves the loopback proxy. It is refused on GitHub-hosted runners with `E_POLICY_POOL_CI`.
- Claude pool routes stay refused under CI regardless (`E_POLICY_POOL_CI`). The switch is `CI_POOL_ALLOWS_CLAUDE = false`, pending the operator's decision on Claude.
- Workflows select the pool credential `AGENT_CI_PROXY_API_KEY` through the same static credential chain as the other model secrets. The Claude pool credential `ANTHROPIC_AUTH_TOKEN` is not wired into any workflow.

The original decision above is unchanged for Claude.


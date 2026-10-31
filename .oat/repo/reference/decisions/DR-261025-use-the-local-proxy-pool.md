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

## Note 2026-10-25: what enabling Claude pool routes in CI requires (final review)

The amendment above calls `CI_POOL_ALLOWS_CLAUDE = false` "the switch". That constant is the single policy point, but flipping it alone does not let a Claude pool route run in any workflow. The Claude pool routes name `ANTHROPIC_AUTH_TOKEN`. That variable is outside `WORKFLOW_MODEL_SECRETS` (`src/commands/route.ts`), so `agent-ci route --github-output` refuses those routes with `E_ROUTE_CONFIG`, and no workflow's static credential chain or secret declaration carries it.

Enabling them needs every one of these:

- `CI_POOL_ALLOWS_CLAUDE = true`;
- `ANTHROPIC_AUTH_TOKEN` added to `WORKFLOW_MODEL_SECRETS`;
- the four static credential chains (`run-agent.yml` and the three in `pr-review.yml`) and the secret declarations and forwarding in `run-agent.yml`, `pr-review.yml`, `fan-out.yml`, `docs-update.yml` and `instructions-update.yml`, with matching workflow structure tests.

The other way is a Claude pool route that names a credential already in that list. No behavior changes here; the decision stays with the operator, including whether to key the rule to billing instead of model family.

> Note (2026-10-25, later): the pending Claude-in-CI question was decided in DR-261025-keep-claude-pool-routes — Claude pool routes stay refused in CI.

## Status note 2026-10-28

The pool origin can now be overridden with the optional `AGENT_CI_PROXY_BASE_URL` secret (an environment variable locally). When it is set to an `https` origin, every `account: pool` route uses that origin and keeps its own path (for example `/v1`), so a self-hosted runner that cannot reach the host's loopback, such as the Dev Mini CI VM, can use the operator's private HTTPS proxy endpoint. agent-ci treats the value as a secret, and the workflows pass it only to the agent and review steps of a pool route. The policy is unchanged: pool routes still need the opt-in and, under CI, a self-hosted runner, and Claude pool routes stay refused in CI.

---
id: DR-261110-allow-pool-routes-on-hosted
title: Allow pool routes on hosted runners over https
date: 2026-11-10
status: accepted
legacy_id: null
---

# Allow pool routes on hosted runners over https

## Context

`checkPoolPolicy` (`src/routing/policy.ts`) refuses every pool route in CI
unless `RUNNER_ENVIRONMENT=self-hosted` (`E_POLICY_POOL_CI`). The rule assumed
the pool is reachable only on the runner host's loopback. Since 2026-10-28,
`AGENT_CI_PROXY_BASE_URL` can name a remote https origin
(DR-261025-use-the-local-proxy-pool, status note), and the operator's proxy is
reachable from the internet. DR-261031-production-reviews-and-pool-ci allowed
Claude pool routes through Claude Code on opted-in self-hosted runners.

A public fleet repository (`consumer-workflows/agent-ci-fleet.yml`) cannot use
a self-hosted runner safely: any pull request, including one from a fork, can
add a workflow that runs on a runner registered to the repository, and runners
on a personal account cannot be restricted to particular workflows. So a
public fleet has no way to use the pool today.

On 2026-11-09 the operator asked for public fleets they configure to reach the
pool, and accepted the residual risk described under Consequences.

## Decision

Under CI, a pool route may also resolve on a runner that is not self-hosted
when `AGENT_CI_PROXY_BASE_URL` is set to a valid origin whose host is not a
loopback host. `parseOrigin` (`src/routing/proxy-origin.ts`) already accepts
`http` only for loopback hosts, so the accepted origin is always https. On a
self-hosted runner the rule is unchanged: loopback or the override.

Everything else stays:

- every pool route still needs the explicit opt-in (`allow_pool: true`, or
  `--allow-pool` locally);
- Claude models run only through Claude Code;
- a skipped subscription route never falls back to a paid route;
- `CODEX_OPENAI_API_KEY` is never used.

The rule is checked wherever a route resolves, so both the resolve step and
the agent step need the proxy origin. The resolve job checks out only the
agent-ci helpers, never target code, so receiving the origin there exposes it
to no repository code. The agent step already receives it for pool routes.

The public fleet template documents the setup as a commented example. It stays
off by default: the template does not set `allow_pool` and passes no pool
secrets.

## Consequences

- The pool key, `AGENT_CI_PROXY_API_KEY` or `ANTHROPIC_AUTH_TOKEN` mapped from
  it, reaches the agent step on a GitHub-hosted VM. This is the same exposure
  the public fleet's `CLAUDE_CODE_OAUTH_TOKEN` already has
  (`docs/security-model.md`, residual risk "An agent can leak its own
  credential on purpose").
- The accepted risk is prompt injection from target content. Only the
  operator can dispatch the fleet or change its targets, and fork pull
  requests receive no secrets. An attacker would need malicious text merged
  into a target repository, or into a dependency file the agent reads. The
  output guard masks only exact values, so an encoded key could still leave.
- Mitigation recommended in the docs: give each fleet its own pool key,
  rate-limited where the proxy supports it, so a leak costs one rotation.
- The rule is not limited to fleets. Any caller on a GitHub-hosted runner with
  `allow_pool: true` and a remote origin may use the pool, including PR
  reviews, whose existing write-access gate stays the trust boundary.
- The proxy origin stays a guarded secret and never appears in errors or logs.
- `docs/running-models.md` gains a setup for a remote endpoint on
  GitHub-hosted runners, and `docs/harnesses-and-routing.md#policy` states the
  new rule.
- Tests cover: allowed with a remote https origin; refused on a GitHub-hosted
  runner with no origin, a loopback origin, or no opt-in; self-hosted behavior
  unchanged.
- Fleet-defined routes and models (issue #16,
  BL-261110-let-a-fleet-add-its-own-pool) remain separate work.

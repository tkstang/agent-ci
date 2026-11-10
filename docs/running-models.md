---
title: Choosing how models run
description: The ways a workflow can reach a model (subscription token, your machine's proxy pool, your pool's https endpoint, a paid API key), what each one needs and which fleet template uses it.
---

# Choosing how models run

Every agent run resolves one route from `models.yaml`. The route decides the
harness, the one credential the agent receives and where requests go. Before
you copy a template, decide how your models will be reached. That choice
decides the runner, the secrets and the template.

This page compares the setups and points to the pages that own the details:
secrets and runner setup in [Configuration and credentials](configuration.md),
routes and policy in [Harnesses and routing](harnesses-and-routing.md), and
what each job can reach in [Security model](security-model.md).

## Contents

- [The setups](#the-setups)
- [Subscription token on GitHub-hosted runners](#subscription-token-on-github-hosted-runners)
- [Your machine: the proxy pool on a self-hosted runner](#your-machine-the-proxy-pool-on-a-self-hosted-runner)
- [Your endpoint: the proxy pool over https on GitHub-hosted runners](#your-endpoint-the-proxy-pool-over-https-on-github-hosted-runners)
- [Paid API key](#paid-api-key)
- [Which template to start from](#which-template-to-start-from)

## The setups

| Setup                      | Runner                                      | How the model is reached                                                | What you provide                                                               | Main risk                                                                    |
| -------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Subscription token         | GitHub-hosted                               | Directly, with your own subscription token                              | The route's token, for example `CLAUDE_CODE_OAUTH_TOKEN` or `OPENCODE_API_KEY` | The token reaches the agent step of every run that uses its route            |
| Your machine (proxy pool)  | Self-hosted, registered to a private caller | Your CLIProxyAPI pool, on loopback or through `AGENT_CI_PROXY_BASE_URL` | The pool key, `allow_pool: true`, an admitted runner                           | Whoever can change the caller's workflows controls what runs on your machine |
| Your endpoint (proxy pool) | GitHub-hosted                               | Your CLIProxyAPI pool at its https origin, `AGENT_CI_PROXY_BASE_URL`    | The pool key, the origin, `allow_pool: true`                                   | The pool key reaches the agent step, and a leaked key works from anywhere    |
| Paid API key               | Any                                         | The provider API, metered                                               | The API key and an exact `route:`                                              | It spends money; agent-ci never chooses it for you                           |

Which routes resolve in CI, and why a skipped subscription route never falls
back to a paid one, is described under
[Policy](harnesses-and-routing.md#policy). Claude models always run through
Claude Code, whichever setup reaches them.

## Subscription token on GitHub-hosted runners

The simplest setup and the public fleet's default. Store the route's token as
a repository secret and pass it under `secrets:`. On a GitHub-hosted runner,
`claude-haiku-5-5` skips its pool route and resolves to
`claude-haiku-5-5-personal`, which uses `CLAUDE_CODE_OAUTH_TOKEN` (create it
with `claude setup-token`). The OpenCode key routes use `OPENCODE_API_KEY`.

Each secret is described in [Configuration and credentials](configuration.md#secrets);
which routes have been live-qualified is listed under
[Current routes](harnesses-and-routing.md#current-routes).

## Your machine: the proxy pool on a self-hosted runner

Use this to run pooled subscriptions (Claude through Claude Code, Codex)
from your own machine. Register a self-hosted runner that can reach your
CLIProxyAPI pool, set `runs_on` to its labels and `allow_pool: true`, and pass
the pool key: `AGENT_CI_PROXY_API_KEY` for Codex routes, mapped to
`ANTHROPIC_AUTH_TOKEN` for Claude Code routes. The pool is reached at
`http://127.0.0.1:8317` unless `AGENT_CI_PROXY_BASE_URL` names another https
origin, for example when the runner is a VM that cannot reach its host's
loopback.

The runner runs target code and the agent. Register it only to a private
caller: in a public repository, a fork pull request can add a workflow that
runs on any self-hosted runner the repository has. Give each fleet its own
runner and prefer one that is discarded after each job. Runner admission and proxy setup are
described in
[Self-hosted runners and the proxy](configuration.md#self-hosted-runners-and-the-proxy).

## Your endpoint: the proxy pool over https on GitHub-hosted runners

Use this to run pooled subscriptions from GitHub-hosted runners, including
from a public fleet, when your CLIProxyAPI pool is reachable from the
internet over https. Set `allow_pool: true`, and pass the pool key as above
plus the `AGENT_CI_PROXY_BASE_URL` secret with the pool's origin
(`https://host[:port]`, nothing after it). On a runner that is not
self-hosted, a pool route resolves only when that origin is valid and its
host does not reach the runner itself: no loopback or unspecified address
(DR-261110-allow-pool-routes-on-hosted).

Each job runs on a fresh GitHub VM, and fork pull requests receive no
secrets, so neither your machine nor the key is exposed to outside
contributors. The key does reach the agent step of every pool run you start,
like a subscription token, so an injected instruction in a target's files
could make the agent leak it, and a leaked key works from any network. Give
each fleet its own pool key, rate-limited where your proxy supports it, so a
leak costs one rotation. The origin is masked in logs, but treat its host
name as discoverable (see the private proxy origin in the
[Security model](security-model.md)).

## Paid API key

A `paid-api` route, such as `claude-haiku-5-5-api` with `ANTHROPIC_API_KEY`,
runs only when a target or caller names it exactly with `route:`. It works on
any runner. agent-ci never falls back to it when a subscription route is
unavailable.

## Which template to start from

| Template                                        | Targets                                                                                     | Default setup                     | Other setups                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| `consumer-workflows/agent-ci-fleet.yml`         | Public only (`public_only: true`, see [Workflows](workflows.md#fan-outyml-and-targetsyaml)) | Subscription token, GitHub-hosted | Your endpoint (commented block), a paid API key, or another route's token under `secrets:` |
| `consumer-workflows/agent-ci-private-fleet.yml` | Private                                                                                     | Your machine                      | Your endpoint, or a route's token under `secrets:`                                         |

Setting up either fleet repository is described in
[Using agent-ci from another repository](fleet-repo.md).

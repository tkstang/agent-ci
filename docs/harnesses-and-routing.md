---
title: Harnesses and routing
description: How agent-ci turns a model name into a harness, credential and account through models.yaml and its routing policy.
---

# Harnesses and routing

A caller names a model, for example `claude-haiku-4-5` or `grok-4.7`.
agent-ci looks the model up in `models.yaml`, picks one route under its
routing policy, and runs that route's harness CLI with only the credential
the route names. This page is the reference for harnesses, the routing
table and the policy. Where each credential comes from is in
[Configuration and credentials](configuration.md).

## Harnesses

A harness is the agent CLI agent-ci drives. Each run starts it with stdin
closed, a deadline with a process-group kill, an output cap, an environment
built from an allowlist, and an isolated home directory (see
[Security model](security-model.md#isolated-home-and-environment)).

| Harness    | CLI and pinned version                                               | Read-only posture                                                           | Edit posture                                                             | Structured output | Repair turn               |
| ---------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------- | ------------------------- |
| `claude`   | `claude` (`@anthropic-ai/claude-code` 2.1.310)                       | `--permission-mode dontAsk`, tools `Read,Grep,Glob,Skill`                   | `--permission-mode acceptEdits`; installed skills readable, not writable | `--json-schema`   | yes (`--resume`)          |
| `codex`    | `codex` (`@openai/codex` 0.163.0)                                    | `-s read-only` (a read-only shell remains)                                  | `-s workspace-write`                                                     | `--output-schema` | yes (`codex exec resume`) |
| `opencode` | `opencode` (`@opencode/cli` 2.0.27)                                  | deny rules for edit, bash, shell, webfetch, websearch, question and execute | `--auto`; webfetch, websearch and question denied                        | prompt and parse  | yes                       |
| `cursor`   | `agent` (Cursor agent CLI 2026.10.22-27dcf5f, sha256-pinned tarball) | `--mode ask`                                                                | `--force`                                                                | prompt and parse  | no                        |
| `fake`     | built in                                                             | no model, no credential                                                     | writes one file (`fake-edit`)                                            | built in          | n/a                       |

Every Claude run also passes `--setting-sources user` and
`--strict-mcp-config`, so the target repository's `.claude/settings.json`
and MCP configuration are not loaded. OpenCode runs set
`OPENCODE_DISABLE_PROJECT_CONFIG=1`, so a repository's `opencode.json`
cannot relax the deny rules. Cursor refuses (`E_UNSAFE_WORKSPACE`) a
workspace that carries project hooks or a `.cursor/cli.json` that grants
permissions, because the Cursor agent runs project hooks even in read-only
mode.

"Repair turn" is the one extra turn agent-ci takes, by resuming the same
session, when a structured answer fails validation. Two review features
need more than the read-only posture:

- The PR-review adjudicator needs a tool-free run. Only `claude` (with
  `--tools ""`) offers one.
- The verify-review `run_check` tool needs an MCP bridge. Only `claude` and
  `codex` offer one.

The `fake` harness backs the credential-free self-tests. Its models are
`fake-echo` (a report), `fake-edit` (edits one file), `fake-review` (one
review finding), `fake-verify-review` (calls `run_check`) and
`fake-adjudicate` (keeps every finding).

## The routing table

`models.yaml` at the repository root is the routing table. Workflows always
use the copy at the agent-ci commit they run, so adding a route means
changing agent-ci itself. Locally, `--models <path>` points any command at
another table.

Each route has these fields (`src/routing/schema.ts`):

| Field              | Required | Meaning                                                                                                                 |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`               | yes      | Lowercase route ID, selectable with `--route`.                                                                          |
| `model`            | yes      | The model name callers use. Several routes can share one.                                                               |
| `harness`          | yes      | `claude`, `codex`, `opencode`, `cursor` or `fake`.                                                                      |
| `family`           | yes      | Model family (`claude`, `openai`, `xai`, `zhipu`, `moonshot`, `deepseek`, `qwen`, `google`, `cursor`, `fake`, `other`). |
| `providerModel`    | yes      | The model ID the harness expects.                                                                                       |
| `credentials`      | no       | Names of the environment variables the route may receive. Default none.                                                 |
| `login`            | no       | `true` when the route authenticates through a seeded harness login. Default `false`.                                    |
| `baseUrl`          | no       | Endpoint override (`ANTHROPIC_BASE_URL` for Claude, the provider `base_url` for Codex).                                 |
| `effort`           | no       | Reasoning-effort hint for harnesses that take one.                                                                      |
| `billing`          | yes      | `subscription` (a plan's included usage), `paid-api` (metered) or `none` (fake only).                                   |
| `account`          | yes      | `personal`, `work` or `pool` (the operator's local proxy pool).                                                         |
| `structuredOutput` | yes      | `json-schema`, `output-schema` or `prompt`.                                                                             |
| `qualified`        | yes      | Date of the last live check of this exact route, or `null`.                                                             |
| `notes`            | no       | Free text.                                                                                                              |

The table loads only if every route passes these checks, else
`E_ROUTE_CONFIG`, `E_POLICY_HARNESS` or `E_POLICY_CREDENTIAL`:

- A Claude-family route, or a model or provider ID that looks like Claude
  (`claude`, `anthropic`, `sonnet`, `opus`, `haiku`), must use the `claude`
  harness, and the `claude` harness serves only the `claude` family. The
  `family` field is the primary guard; the name check misses
  separator-less IDs such as `sonnet4.5` (see
  [Security model](security-model.md#residual-risk)).
- `family: fake`, `harness: fake` and `billing: none` go together.
- A `subscription` route may not name a paid API key (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_OPENAI_API_KEY`).
- A non-fake route names at least one credential or sets `login: true`.
- Route IDs are unique.

## How a model resolves

`agent-ci run`, `route`, `review` and `targets` resolve the same way
(`src/routing/resolve.ts`):

1. `--route <id>` selects that route. It must serve `--model` and match
   `--harness` when those are also given. It is the only way to use a
   `paid-api` route or a route the fallback rules below would refuse.
2. Otherwise every route for the model is a candidate, in file order,
   narrowed to `--harness` when given. A Claude model pinned to another
   harness fails with `E_POLICY_HARNESS`.
3. Candidates the policy refuses are skipped and reported (`skipped` in the
   output). The first eligible one wins, with two exceptions that stop
   resolution instead of falling back:
   - `E_POLICY_FALLBACK`: a `paid-api` route after a skipped `subscription`
     route.
   - `E_POLICY_ACCOUNT_FALLBACK`: a `work` route after a skipped route of
     another account. Pin it with `--harness` or `--route` if the work
     account is intended.

For example, `grok-4.7` has three routes: the OpenCode login route, the
OpenCode key route, and a Cursor route on the work account. With
`CURSOR_API_KEY` set but neither `--seed-login` nor `OPENCODE_API_KEY`,
`agent-ci run --model grok-4.7` stops with `E_POLICY_ACCOUNT_FALLBACK`
rather than spend the work account; `--harness cursor` selects it
deliberately.

## Policy

Each request is checked against the route and the environment
(`src/routing/policy.ts`). CI means `CI` or `GITHUB_ACTIONS` is set.

| Rule                                                                                                                                                                                                                                         | Code                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| A `pool` route needs the opt-in: `--allow-pool` locally, the `allow_pool: true` workflow input in Actions (`--allow-pool-value true`).                                                                                                       | `E_POLICY_POOL`                                  |
| In CI, a `pool` route runs only on a self-hosted runner (`RUNNER_ENVIRONMENT=self-hosted`), because a GitHub-hosted runner cannot reach a loopback proxy.                                                                                    | `E_POLICY_POOL_CI`                               |
| In CI, a Claude-family `pool` route is refused on every runner while `CI_POOL_ALLOWS_CLAUDE` is `false` in `src/routing/policy.ts`. Changing that constant alone would not let one run in a workflow; see [The proxy pool](#the-proxy-pool). | `E_POLICY_POOL_CI`                               |
| A `login` route is local only, and needs `--seed-login`.                                                                                                                                                                                     | `E_POLICY_LOGIN_CI`, `E_CREDENTIAL_MISSING`      |
| Every credential the route names must be set and non-empty. `agent-ci route`, the review gate and `targets` skip this check, because a workflow resolves the route before it maps the credential into the agent step.                        | `E_CREDENTIAL_MISSING`                           |
| No fallback from subscription to paid billing, or into a work account.                                                                                                                                                                       | `E_POLICY_FALLBACK`, `E_POLICY_ACCOUNT_FALLBACK` |

The child process receives only the route's named credential variables.
Every other known credential variable in your environment
(`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
`OPENAI_API_KEY`, `OPENCODE_API_KEY`, `CURSOR_API_KEY`, GitHub tokens and
others) is dropped before the harness starts.

### Seeded logins

`--seed-login` copies an existing harness login from your real home into the
run's isolated home, for routes with `login: true`. It is refused in CI
(`E_SEED_REFUSED`). Supported sources:

- `codex`: `auth.json` in `$CODEX_HOME` (default: the `.codex` directory in
  your home).
- `claude`: `.claude/.credentials.json` in your home, which exists on Linux;
  the macOS Keychain login cannot be seeded.
- `opencode`: exported from your OpenCode login store and imported into the
  isolated home. Both commands run in the isolated home with a deadline, an
  output cap and a process-group kill, and the time they take counts against
  the run's `--timeout-minutes` (`E_HARNESS_TIMEOUT`, `E_HARNESS_OUTPUT_LIMIT`).
- `cursor`: not supported (`E_SEED_UNSUPPORTED`).

Token-like values from the seeded login are added to the output secret
guard, so a run that echoes them fails.

### The proxy pool

`account: pool` routes spend the operator's CLIProxyAPI pool through a
loopback `baseUrl` (`http://127.0.0.1:8317`). Locally they need
`--allow-pool` and the pool key: `ANTHROPIC_AUTH_TOKEN` for the Claude pool
routes, `AGENT_CI_PROXY_API_KEY` for the Codex pool route. In Actions only
the non-Claude pool route can run, on a self-hosted runner whose host serves
the proxy, with `allow_pool: true` and the `AGENT_CI_PROXY_API_KEY` secret;
the workflows never pass `ANTHROPIC_AUTH_TOKEN`. Running a Claude pool route in
Actions would need both a policy change (`CI_POOL_ALLOWS_CLAUDE`) and
credential wiring: `ANTHROPIC_AUTH_TOKEN` is not among the credentials
`agent-ci route --github-output` accepts (it refuses the Claude pool routes
with `E_ROUTE_CONFIG`) and is in no workflow's credential chain. The operator
decided to keep Claude pool routes refused in CI
(DR-261025-keep-claude-pool-routes). Runner setup is in
[Configuration and credentials](configuration.md#self-hosted-runners-and-the-proxy).

When `AGENT_CI_PROXY_BASE_URL` is set, every pool route takes its origin
from it and keeps its own path, so the Codex pool route uses
`https://proxy.example.com/v1` for an origin of `https://proxy.example.com`.
The value must be a bare `https` origin (`http` only for a loopback host)
and is otherwise refused with `E_ROUTE_CONFIG`. It changes where the pool is
reached, not who may use it: the policy above applies unchanged. agent-ci
treats the value as a secret, never prints it, and refuses agent output
that contains it; the workflows pass it only to the agent, review and
adjudicator steps of a pool route.

## Current routes

As of this commit (`agent-ci models` prints the live table):

| Model                 | Route                                | Harness  | Account  | Billing      | Credential                | Qualified  |
| --------------------- | ------------------------------------ | -------- | -------- | ------------ | ------------------------- | ---------- |
| `claude-haiku-4-5`    | `claude-haiku-4-5-pool`              | claude   | pool     | subscription | `ANTHROPIC_AUTH_TOKEN`    | 2026-10-25 |
| `claude-haiku-4-5`    | `claude-haiku-4-5-personal`          | claude   | personal | subscription | `CLAUDE_CODE_OAUTH_TOKEN` | not yet    |
| `claude-haiku-4-5`    | `claude-haiku-4-5-api`               | claude   | personal | paid-api     | `ANTHROPIC_API_KEY`       | not yet    |
| `claude-haiku-5-5`    | `claude-haiku-5-5-pool`              | claude   | pool     | subscription | `ANTHROPIC_AUTH_TOKEN`    | 2026-10-25 |
| `gpt-5.6-luna`        | `gpt-5.6-luna-pool`                  | codex    | pool     | subscription | `AGENT_CI_PROXY_API_KEY`  | 2026-10-25 |
| `grok-4.7`            | `grok-4.7-opencode-login`            | opencode | personal | subscription | seeded login              | 2026-10-25 |
| `grok-4.7`            | `grok-4.7-opencode`                  | opencode | personal | subscription | `OPENCODE_API_KEY`        | 2026-10-26 |
| `glm-5.3-flash`       | `glm-5.3-flash-opencode-login`       | opencode | personal | subscription | seeded login              | 2026-10-25 |
| `glm-5.3-flash`       | `glm-5.3-flash-opencode`             | opencode | personal | subscription | `OPENCODE_API_KEY`        | not yet    |
| `deepseek-v4.1-flash` | `deepseek-v4.1-flash-opencode-login` | opencode | personal | subscription | seeded login              | 2026-10-26 |
| `deepseek-v4.1-flash` | `deepseek-v4.1-flash-opencode`       | opencode | personal | subscription | `OPENCODE_API_KEY`        | not yet    |
| `grok-4.7`            | `grok-4.7-cursor`                    | cursor   | work     | subscription | `CURSOR_API_KEY`          | 2026-10-25 |

The routes a hosted Actions runner can use are `claude-haiku-4-5-personal`,
`claude-haiku-4-5-api` (by `route` only), the three `OPENCODE_API_KEY`
routes (`grok-4.7-opencode`, `glm-5.3-flash-opencode`,
`deepseek-v4.1-flash-opencode`) and `grok-4.7-cursor` (pinned). Of the key
routes, only `grok-4.7-opencode` has run live in Actions (2026-10-26, a fleet
docs update). OpenCode Go bills
DeepSeek V4.1 Flash at twice its off-peak rate during peak hours (01:00-04:00
and 06:00-10:00 UTC, Monday to Friday), so schedule it outside them.

## Inspect routing

```bash
agent-ci models --model grok-4.7
agent-ci route --model grok-4.7
agent-ci route --model claude-haiku-4-5 --allow-pool
agent-ci doctor --allow-pool --seed-login
```

In a workflow, `agent-ci route --github-output` also writes `route_id`,
`model`, `harness`, `account`, `billing` and `credential` for later steps,
and refuses a route that names more than one credential or one outside
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENCODE_API_KEY`,
`CURSOR_API_KEY` and `AGENT_CI_PROXY_API_KEY`, the secrets the workflows can
pass.

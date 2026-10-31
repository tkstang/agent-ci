---
title: Harnesses and routing
description: How agent-ci turns a model name into a harness, credential and account through models.yaml and its routing policy.
---

# Harnesses and routing

A caller names a model, for example `gpt-6.1-sol-high` or
`claude-opus-5-5-high`.
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

Routes can fix a reasoning effort independently of the provider model. The
`gpt-6.1-sol-high` and `gpt-6.1-sol-low` model keys both use provider model
`gpt-6.1-sol`, with `high` and `low` effort respectively. Distinct keys keep
per-pass effort deterministic without relying on route order. Claude routes
forward their effort as `--effort`; Codex routes use `model_reasoning_effort`.
The new Sol and Opus review routes have not yet been qualified live.

"Repair turn" is the one extra turn agent-ci takes when a structured answer
fails validation. CLI harnesses resume the same session where supported.
The direct adjudicator uses stateless local prompt/previous-answer context. Two review features
need more than the read-only posture:

- The PR-review adjudicator needs a tool-free run. Claude Code uses
  `--tools ""`; the fake harness supports credential-free tests. The exact
  `gpt-6.1-sol-low` pool route uses a dedicated Responses transport instead
  of Codex CLI. It requires provider `gpt-6.1-sol`, effort `low`, harness
  `codex`, family `openai`, subscription billing, pool account, no seeded
  login, exactly `AGENT_CI_PROXY_API_KEY`, and a pool endpoint with `/v1`.
  Other Codex aliases, efforts, accounts and paid API substitutions are
  refused before spending. Planning, `route --purpose adjudicator`, local
  binary pinning and runtime use the same eligibility function. Route
  output reports `transport: adjudicator-responses` without the endpoint;
  the adjudicator workflow skips CLI installation for that transport.
  Ordinary Codex runs retain their CLI behavior and refuse tool-free mode.
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
  harness, including separator-less IDs such as `sonnet4.5`, `opus41` and
  `haiku4`. The `claude` harness serves only the `claude` family.
- Cursor requires an explicit non-Claude `providerModel`. Automatic selectors
  (`auto`, `auto-smart`, `default` and parameterized forms such as
  `auto(quality=high)`) are rejected with `E_POLICY_HARNESS`, regardless of
  case or surrounding whitespace, because they may choose Claude. A neutral
  model key such as `auto` is allowed when its provider model is explicit.
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
     another account. Pin it with `--harness` or `--route` if account
     class `work` is intended.

For example, `grok-4.7` has three routes: the OpenCode login route, the
OpenCode key route, and a Cursor route with `account: work`. With
`CURSOR_API_KEY` set but neither `--seed-login` nor `OPENCODE_API_KEY`,
`agent-ci run --model grok-4.7` stops with `E_POLICY_ACCOUNT_FALLBACK`
rather than switch account classes; `--harness cursor` selects it
deliberately.

## Policy

Each request is checked against the route and the environment
(`src/routing/policy.ts`). CI means `CI` or `GITHUB_ACTIONS` is set.

| Rule                                                                                                                                                                                                                  | Code                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| A `pool` route needs the opt-in: `--allow-pool` locally, the `allow_pool: true` workflow input in Actions (`--allow-pool-value true`).                                                                                | `E_POLICY_POOL`                                  |
| In CI, a `pool` route runs only on a self-hosted runner (`RUNNER_ENVIRONMENT=self-hosted`), by policy; by default the pool is a loopback address that a GitHub-hosted runner cannot reach.                            | `E_POLICY_POOL_CI`                               |
| A `login` route is local only, and needs `--seed-login`.                                                                                                                                                              | `E_POLICY_LOGIN_CI`, `E_CREDENTIAL_MISSING`      |
| Every credential the route names must be set and non-empty. `agent-ci route`, the review gate and `targets` skip this check, because a workflow resolves the route before it maps the credential into the agent step. | `E_CREDENTIAL_MISSING`                           |
| No fallback from subscription to paid billing, or into account class `work`.                                                                                                                                          | `E_POLICY_FALLBACK`, `E_POLICY_ACCOUNT_FALLBACK` |

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

`account: pool` routes spend the operator's CLIProxyAPI subscription pool
through a loopback `baseUrl` (`http://127.0.0.1:8317`). They need
`--allow-pool` locally. In Actions, every pool route requires an admitted
self-hosted runner that can reach the proxy and explicit `allow_pool: true`.
Claude pool routes still run only through Claude Code; they use
`ANTHROPIC_AUTH_TOKEN`. Codex pool routes use `AGENT_CI_PROXY_API_KEY`.

Both credential names are selectable by the workflows' static secret chains.
A caller can map its existing pool secret to the Claude credential name:

```yaml
secrets:
  AGENT_CI_PROXY_API_KEY: ${{ secrets.AGENT_CI_PROXY_API_KEY }}
  ANTHROPIC_AUTH_TOKEN: ${{ secrets.AGENT_CI_PROXY_API_KEY }}
```

The defaults do not enable pool spending or choose a self-hosted runner for
you. Configure both explicitly before using the default Sol reviewer or the
optional Opus reviewer. Runner setup is in
[Configuration and credentials](configuration.md#self-hosted-runners-and-the-proxy).

When `AGENT_CI_PROXY_BASE_URL` is set, every pool route takes its origin
from it and keeps its own path, so the Codex pool route uses
`https://localhost/v1` for an origin of `https://localhost`.
The value must be a canonical `https` origin with no trailing slash
(`http` only for a loopback host) and is otherwise refused with
`E_ROUTE_CONFIG`. It changes where the pool is
reached, not who may use it: the policy above applies unchanged. agent-ci
treats the value as a secret, never prints it, and refuses agent output
that contains it; the workflows pass it only to the agent, review and
adjudicator steps of a pool route.

## Current routes

As of this commit (`agent-ci models` prints the live table):

| Model                  | Route                                | Harness  | Account  | Billing      | Credential                | Qualified  |
| ---------------------- | ------------------------------------ | -------- | -------- | ------------ | ------------------------- | ---------- |
| `claude-haiku-4-5`     | `claude-haiku-4-5-pool`              | claude   | pool     | subscription | `ANTHROPIC_AUTH_TOKEN`    | 2026-10-25 |
| `claude-haiku-4-5`     | `claude-haiku-4-5-personal`          | claude   | personal | subscription | `CLAUDE_CODE_OAUTH_TOKEN` | not yet    |
| `claude-haiku-4-5`     | `claude-haiku-4-5-api`               | claude   | personal | paid-api     | `ANTHROPIC_API_KEY`       | not yet    |
| `claude-haiku-5-5`     | `claude-haiku-5-5-pool`              | claude   | pool     | subscription | `ANTHROPIC_AUTH_TOKEN`    | 2026-10-25 |
| `gpt-6.1-sol-high`     | `gpt-6.1-sol-high-pool`              | codex    | pool     | subscription | `AGENT_CI_PROXY_API_KEY`  | not yet    |
| `gpt-6.1-sol-low`      | `gpt-6.1-sol-low-pool`               | codex    | pool     | subscription | `AGENT_CI_PROXY_API_KEY`  | not yet    |
| `claude-opus-5-5-high` | `claude-opus-5-5-high-pool`          | claude   | pool     | subscription | `ANTHROPIC_AUTH_TOKEN`    | not yet    |
| `gpt-5.6-luna`         | `gpt-5.6-luna-pool`                  | codex    | pool     | subscription | `AGENT_CI_PROXY_API_KEY`  | 2026-10-25 |
| `grok-4.7`             | `grok-4.7-opencode-login`            | opencode | personal | subscription | seeded login              | 2026-10-25 |
| `grok-4.7`             | `grok-4.7-opencode`                  | opencode | personal | subscription | `OPENCODE_API_KEY`        | 2026-10-26 |
| `glm-5.3-flash`        | `glm-5.3-flash-opencode-login`       | opencode | personal | subscription | seeded login              | 2026-10-25 |
| `glm-5.3-flash`        | `glm-5.3-flash-opencode`             | opencode | personal | subscription | `OPENCODE_API_KEY`        | not yet    |
| `deepseek-v4.1-flash`  | `deepseek-v4.1-flash-opencode-login` | opencode | personal | subscription | seeded login              | 2026-10-26 |
| `deepseek-v4.1-flash`  | `deepseek-v4.1-flash-opencode`       | opencode | personal | subscription | `OPENCODE_API_KEY`        | 2026-10-30 |
| `grok-4.7`             | `grok-4.7-cursor`                    | cursor   | work     | subscription | `CURSOR_API_KEY`          | 2026-10-25 |

The five `fake-*` routes (harness `fake`, billing `none`) are omitted.

The routes a hosted Actions runner can use are `claude-haiku-4-5-personal`,
`claude-haiku-4-5-api` (by `route` only), the three `OPENCODE_API_KEY`
routes (`grok-4.7-opencode`, `glm-5.3-flash-opencode`,
`deepseek-v4.1-flash-opencode`) and `grok-4.7-cursor` (pinned). Of the key
routes, `grok-4.7-opencode` (2026-10-26) and `deepseek-v4.1-flash-opencode`
(2026-10-30) have run live in Actions, each in a fleet docs update; the GLM
key route has not. OpenCode Go bills
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
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`OPENCODE_API_KEY`, `CURSOR_API_KEY` and `AGENT_CI_PROXY_API_KEY`, the secrets
the workflows can pass.

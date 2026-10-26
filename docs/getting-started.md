---
title: Getting started
description: Build the agent-ci CLI, run it without a model, then run a cheap model and inspect the result files.
---

# Getting started

This tutorial builds the `agent-ci` command-line interface (CLI) from a
checkout, runs it once with the built-in `fake` harness (no model, no
credential), and then runs a cheap model. It ends with the commands that
show which harnesses, credentials and routes your machine can use.

To run agent-ci from GitHub Actions instead, read [Workflows](workflows.md)
after this page.

## Prerequisites

- Node.js 24 or later and pnpm 11 (`package.json` pins `pnpm@11.8.0` and
  `engines.node >=24`).
- A clone of `tkstang/agent-ci`. The repository is private.
- For a model-backed run, the harness CLI the route uses, on `PATH`:
  `claude` (Claude Code), `codex`, `opencode` or `agent` (Cursor). See
  [Install harness CLIs](#install-harness-clis).

## Build the CLI

```bash
pnpm install
pnpm build
alias agent-ci="node $PWD/dist/cli.js"
agent-ci --help
```

`pnpm build` writes `dist/cli.js`, the `agent-ci` binary. The alias is a
convenience for this shell; the workflows put `agent-ci` on `PATH` through
the `.github/actions/setup-agent-ci` action instead.

Every command prints exactly one JSON envelope on stdout and writes logs to
stderr. A success looks like `{"ok":true,"command":"run","data":{...}}`; a
failure carries a machine-readable `code` (for example
`E_CREDENTIAL_MISSING`), a `message` and sometimes a `hint`. The exit code is
`1` for errors you can fix and `2` for harness or system faults.

## Run without a model

Run the `fake-echo` model in any git repository. It needs no credential and
calls no model:

```bash
cd /path/to/a/git/repository
agent-ci run --model fake-echo --prompt "Summarize this repository."
```

Expected stderr line and envelope (abridged):

```txt
agent-ci run: no-op (fake-echo); result at /path/to/a/git/repository/.agent-ci/run-result.json
{"ok":true,"command":"run","data":{"ok":true,"status":"no-op","summary":"Fake harness run (no model was called).","outputContract":"report",...}}
```

The run writes three files to `.agent-ci/` (change it with `--out`):

| File              | Contents                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run-result.json` | The validated result: `status` (`changed`, `no-op` or `failed`), `summary`, the contract's payload (here `report`), `changedFiles` and `errors`. |
| `run-log.jsonl`   | One JSON event per line: the resolved route, each attempt with its usage, and the final result.                                                  |
| `prompt.md`       | The full prompt agent-ci sent, including its own run instructions around yours.                                                                  |

Check a result file against its contract with
`agent-ci validate --file .agent-ci/run-result.json`.

## Run a cheap model

Pick a route your machine can authenticate. Model credentials are read from
environment variables, never from flags, and only the variable the route
names reaches the harness.

With a personal Claude subscription token (create it with
`claude setup-token`; see [Configuration and credentials](configuration.md)):

```bash
export CLAUDE_CODE_OAUTH_TOKEN   # set it from your own secret store first
agent-ci run --model claude-haiku-4-5 --prompt "List the top-level directories and what each holds."
```

With an existing OpenCode Go login on this machine (`opencode` logged in),
seeded into the run's isolated home:

```bash
agent-ci run --model grok-4.7 --seed-login --prompt "List the top-level directories and what each holds."
```

Runs are read-only by default. `--mode edit` lets the agent change files;
an edit run that changed files also writes `.agent-ci/changes.json`, which
`agent-ci publish` turns into a pull request. Other run flags include
`--contract report|changes|issues|verdict`, `--timeout-minutes` (default
30), `--max-attempts` (default 2) and `--prompt-file`. Run
`agent-ci run --help` for the full list.

## Check what this machine can use

```bash
agent-ci doctor
agent-ci models
agent-ci route --model claude-haiku-4-5
```

- `doctor` reports each harness CLI (found, version), each known credential
  variable as present or absent (never its value), and for every route
  whether it is usable now or the policy code that blocks it (for example
  `E_POLICY_POOL` or `E_CREDENTIAL_MISSING`). `--allow-pool` and
  `--seed-login` evaluate routes as if those flags were passed.
- `models` lists every route in `models.yaml`; `--model <name>` narrows it.
- `route` resolves the route a run would use under the current policy,
  without needing the credential, and lists the routes it skipped with the
  reason. For `claude-haiku-4-5` without flags it picks
  `claude-haiku-4-5-personal` and skips the pool route with `E_POLICY_POOL`.

[Harnesses and routing](harnesses-and-routing.md) explains how a model name
becomes a route.

## Install harness CLIs

agent-ci runs the harness CLIs it finds on `PATH`. To install the versions
the workflows pin, use the installer the workflows call:

```bash
agent-ci harness install --harness claude,codex --prefix "$HOME/.local/agent-ci-harness"
export PATH="$HOME/.local/agent-ci-harness/bin:$PATH"
```

It installs into `<prefix>/bin` and checks each CLI with `--version`. The
pinned versions are listed in
[Harnesses and routing](harnesses-and-routing.md#harnesses).

## Next steps

- [Harnesses and routing](harnesses-and-routing.md): choose a model, a
  harness or an exact route.
- [Workflows](workflows.md): run the same thing from GitHub Actions.
- [PR review](pr-review.md): review a pull request locally with
  `agent-ci review run`.

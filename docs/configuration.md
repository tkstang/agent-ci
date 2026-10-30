---
title: Configuration and credentials
description: Every secret agent-ci reads, what each token needs, how to store it, and how to set up runners and the proxy.
---

# Configuration and credentials

This page owns the facts about credentials: which secret each workflow
reads, what permissions each token needs, how to store it, and the GitHub
settings and runners agent-ci depends on. It applies to local runs and to
repositories that call agent-ci's reusable workflows.

## Secrets

Workflows pass secrets to agent-ci explicitly under `secrets:` in the
caller; none is inherited. Each workflow selects the model secret for the
resolved route by a static chain, so it can only ever pass one of the five
model secrets below.

| Secret                       | What it is                                                                                                                                                                                                                                   | What it needs                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Used by                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN`    | Claude subscription token for the `claude-haiku-4-5-personal` route.                                                                                                                                                                         | Create it with `claude setup-token` on a machine where you are logged in to Claude Code with a personal subscription.                                                                                                                                                                                                                                                                                                                                              | Agent step, review passes, adjudicator                                                                                             |
| `OPENCODE_API_KEY`           | OpenCode Go API key for the `*-opencode` key routes (Grok, GLM, DeepSeek).                                                                                                                                                                   | An OpenCode Go key from your OpenCode account.                                                                                                                                                                                                                                                                                                                                                                                                                     | Agent step, review passes                                                                                                          |
| `CURSOR_API_KEY`             | Cursor API key for the `grok-4.7-cursor` route.                                                                                                                                                                                              | A Cursor API key. The route is on the `work` account, so it is used only when a caller pins the `cursor` harness or the route.                                                                                                                                                                                                                                                                                                                                     | Agent step, review passes                                                                                                          |
| `ANTHROPIC_API_KEY`          | Metered Anthropic API key.                                                                                                                                                                                                                   | Used only by the `paid-api` route `claude-haiku-4-5-api`, which a caller must name with `route:` (or `--route`); agent-ci never falls back to it.                                                                                                                                                                                                                                                                                                                  | Agent step, review passes, adjudicator                                                                                             |
| `AGENT_CI_PROXY_API_KEY`     | Key for the operator's CLIProxyAPI pool, for the non-Claude pool route `gpt-5.6-luna-pool`.                                                                                                                                                  | Only on a self-hosted runner that can reach the proxy (on its host, or through `AGENT_CI_PROXY_BASE_URL`), with `allow_pool: true`.                                                                                                                                                                                                                                                                                                                                | Agent step, review passes                                                                                                          |
| `AGENT_CI_PROXY_BASE_URL`    | Optional. Replaces the loopback origin of every pool route with the operator's private proxy endpoint (for example `https://proxy.example.com`); each route keeps its own path, such as `/v1`. Unset or empty keeps `http://127.0.0.1:8317`. | Exactly `scheme://host[:port]` in canonical form: lowercase, `https` (plain `http` only for a loopback host), no default port, no trailing slash, path, query, fragment, user name or surrounding whitespace; anything else fails with `E_ROUTE_CONFIG`. Canonical form keeps the value matching every URL built from it, so output masking catches them all. Store it as a secret, not a variable: Actions prints variables in logs, and the endpoint is private. | Agent step, review passes, adjudicator (wired there, but unused while Claude pool routes are refused in CI); only for a pool route |
| `AGENT_CI_SOURCE_TOKEN`      | Reads the private `tkstang/agent-ci` repository so a job can check out the agent-ci helpers.                                                                                                                                                 | Fine-grained token, repository access `tkstang/agent-ci` only, permission Contents: Read-only. Needed in every repository except agent-ci itself.                                                                                                                                                                                                                                                                                                                  | Every workflow (never the verify job)                                                                                              |
| `AGENT_CI_TARGET_TOKEN`      | Writes to a target repository that is not the calling repository.                                                                                                                                                                            | Fine-grained or GitHub App token on each target, Contents: Read and write and Pull requests: Read and write. Referenced only in the resolve and publish jobs.                                                                                                                                                                                                                                                                                                      | `run-agent.yml`, `tools-update.yml`, `fan-out.yml` and the wrappers                                                                |
| `AGENT_CI_TARGET_READ_TOKEN` | Checks out a private target repository in the jobs that run repository code or the agent.                                                                                                                                                    | Fine-grained or GitHub App token, Contents: Read-only and nothing else. Public targets need none. See [the read-token check](#the-read-token-check).                                                                                                                                                                                                                                                                                                               | Same as the target token                                                                                                           |
| `AGENT_CI_NOTIFY_WEBHOOK`    | Optional incoming-webhook URL (Slack-compatible). agent-ci posts one JSON `{"text": ...}` message per run.                                                                                                                                   | Must be an `https` URL. Unset or empty sends nothing.                                                                                                                                                                                                                                                                                                                                                                                                              | Publish job of `run-agent.yml` and `tools-update.yml`                                                                              |

Two more variables matter only locally:

- `ANTHROPIC_AUTH_TOKEN` is the pool key for the Claude pool routes
  (`claude-haiku-4-5-pool`, `claude-haiku-5-5-pool`). The workflows never
  pass it.
- `GITHUB_TOKEN` or `GH_TOKEN` is the token `agent-ci publish` and
  `agent-ci review` use locally. In Actions they receive the job's own
  `GITHUB_TOKEN`. agent-ci never prints a token.

Credentials reach agent-ci only through the environment. Never pass a token
value as a flag or commit it to a file. `agent-ci doctor` reports each
variable as present or absent without printing values.

### The read-token check

Before any job uses `AGENT_CI_TARGET_READ_TOKEN`, the resolve job
(`agent-ci targets resolve`) refuses it (`E_TARGET_TOKEN`) when it:

- equals `AGENT_CI_TARGET_TOKEN`;
- is a classic token that reports any scope, because a classic token can
  read a private repository only with the writable `repo` scope;
- can write repository contents (a dry-run ref creation succeeds).

No GitHub API reports a fine-grained token's other permissions, so a token
with Contents: Read plus pull-request, Actions, secrets or administration
write access would pass the check and reach the agent job. Grant Contents:
Read only. One read token serves a whole fleet; see
[Security model](security-model.md#residual-risk).

## Store a secret

Use the GitHub CLI and paste the value at its prompt, so the value never
lands in your shell history or a process list:

```bash
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner>/<repository>
```

`<owner>/<repository>` is the repository whose workflow calls agent-ci (for a
fleet, the fleet repository). Repeat for each secret the caller passes.
Store only the model secrets your routes use; a caller that passes more
model secrets than it needs gives every reviewer job all of them (see
[Security model](security-model.md#residual-risk)).

## Repository settings

| Setting                                               | Where                                                                                                  | When                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Actions access for reusable workflows                 | `tkstang/agent-ci`: Settings, Actions, General, Access: accessible from repositories owned by the user | Once, so other repositories you own can call agent-ci's workflows while it is private.                   |
| Allow GitHub Actions to create pull requests          | Calling repository: Settings, Actions, General, Workflow permissions                                   | When the caller publishes pull requests with `GITHUB_TOKEN` (`publish_pr: true`, the wrappers, fan-out). |
| Labels `agent-ci:review` and `agent-ci:verify-review` | Reviewed repository                                                                                    | For label-triggered PR review.                                                                           |

agent-ci always publishes to the calling repository with `GITHUB_TOKEN`; no
input accepts another token for the calling repository. GitHub treats events
made with `GITHUB_TOKEN` specially:

- **Pull request events** (`opened`, `synchronize`, `reopened`) on a pull
  request agent-ci opened or updated create `pull_request` runs that wait
  for approval (`action_required`). A user with write access starts them
  with **Approve workflows to run** on the pull request; no push is needed.
  This repository observed such a held run for a pull request opened by
  `github-actions[bot]`.
- **Push events** from agent-ci's commits to its static branch start no
  workflow run.

To get CI without approval, publish with a token other than `GITHUB_TOKEN`,
for example a GitHub App token. That is possible only for another
repository's target: pass the token as `AGENT_CI_TARGET_TOKEN` and set
`publisher_login` to the identity it acts as, such as `my-app[bot]`.

## Self-hosted runners and the proxy

Every reusable workflow takes `runs_on` (default `ubuntu-latest`) and uses it
for every job. A self-hosted runner is needed only for the proxy pool. A
pool route runs in CI only on a self-hosted runner
(`RUNNER_ENVIRONMENT=self-hosted`); this is policy, not just reachability,
and setting `AGENT_CI_PROXY_BASE_URL` does not lift it. By default a pool
route uses the loopback address `http://127.0.0.1:8317`, so the runner must
run on the proxy's host unless that secret points it at an https endpoint.

1. Register the runner on each repository whose workflow runs on it
   (repository Settings, Actions, Runners, New self-hosted runner). A
   personal account has no account-level runners, so a fleet repository and
   each reviewed repository register their own.
2. Run the runner process on the host that serves the proxy, outside any
   container or virtual machine with its own network namespace. Inside one,
   `127.0.0.1` is the container's loopback and the proxy is unreachable.
   Check it as the runner's user on that host with
   `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8317/`: any
   HTTP status means the proxy is reachable; a connection error means it is
   not. A runner that cannot reach the host's loopback, such as one in a
   virtual machine, can reach the proxy through its private HTTPS endpoint
   instead: set the `AGENT_CI_PROXY_BASE_URL` secret.
3. On a Linux host, let Codex create its sandbox. The only pool route CI can
   run, `gpt-5.6-luna-pool`, uses Codex, whose Linux sandbox (bubblewrap)
   needs unprivileged user namespaces. The workflows lift Ubuntu's AppArmor
   restriction only on GitHub-hosted runners, never on a self-hosted one,
   and then always run `agent-ci harness smoke --harness codex`, which fails
   the job ("Check the Codex sandbox") when the sandbox does not work. On
   Ubuntu 23.10 or later the restriction is on by default. Check it on the
   host with `sysctl kernel.apparmor_restrict_unprivileged_userns` (`1`
   blocks the sandbox), and either set it to `0`
   (`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, plus a
   file under `/etc/sysctl.d/` to keep it after a reboot) or give `bwrap` an
   AppArmor profile that allows user namespaces. Then confirm, as the runner
   user, with `agent-ci harness smoke --harness codex` from an agent-ci
   checkout. A macOS host is not affected: Codex uses the macOS sandbox
   there.
4. Give the runner a label and pass it as `runs_on`, with
   `allow_pool: true`, the `AGENT_CI_PROXY_API_KEY` secret, and a pool model
   such as `gpt-5.6-luna`.

The Actions runner sets `RUNNER_ENVIRONMENT=self-hosted`, which the pool
policy checks whether or not `AGENT_CI_PROXY_BASE_URL` is set, so a
GitHub-hosted runner never runs a pool route. Claude pool routes stay
refused in CI on any runner.
In CI, verify-review is refused when `allow_pool` is on, and the verify job refuses
self-hosted runners unless `verify_on_self_hosted: true` (for ephemeral
runners only), because it runs pull-request code. A pool route has not yet
run on a self-hosted runner; the policy and wiring are covered by unit and
workflow structure tests.

> [!WARNING]
> A self-hosted runner that is reused across jobs keeps whatever a job left
> behind. Do not run untrusted pull-request code on the runner that holds
> the proxy pool.

## Local defaults

| Setting            | Default                                     | Change with                               |
| ------------------ | ------------------------------------------- | ----------------------------------------- |
| Routing table      | `models.yaml` in the agent-ci checkout      | `--models <path>`                         |
| Output directory   | `<cwd>/.agent-ci`                           | `--out <dir>`                             |
| Isolated home root | a temporary root, removed after the run     | `--home-root <dir>` (kept)                |
| Run deadline       | 30 minutes for all attempts                 | `--timeout-minutes <n>`                   |
| Attempts           | 2, for transient failures, 30 seconds apart | `--max-attempts`, `--retry-delay-seconds` |

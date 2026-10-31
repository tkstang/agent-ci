---
title: Security model
description: Where agent-ci draws trust boundaries, how it scopes tokens and credentials, and the residual risks it accepts.
---

# Security model

agent-ci runs a model, with a credential, against repository content that
may be untrusted, and then writes to GitHub. Its design keeps three things
apart: the model credential, write access to GitHub, and code from the
repository or pull request. This page explains where those boundaries are
and what is still exposed. The reasoning behind these choices is in the
[decision records](../.oat/repo/reference/decisions/index.md), and open
gaps are tracked in the [backlog](../.oat/repo/pjm/backlog/index.md).

## Principles

- **The job is the boundary.** On a GitHub-hosted runner any step can read
  every secret its job references, so agent-ci separates authority by job,
  not by step. Tool restrictions and output guards inside a job reduce
  accidents; they do not contain a determined agent.
- **One model credential, only where the agent runs.** The agent receives
  only the credential its route names, in the agent step only.
- **No write token next to the agent.** Jobs that publish hold no model
  credential and run no repository code; jobs that run the agent hold no
  write-capable token.
- **agent-ci never runs repository or pull-request code next to a model
  credential.** It runs no setup command, repository skill or check in a
  job that holds one; in PR review the only job that runs pull-request code
  (the verify-review `verify` job) holds no model credential and no helper
  token. The harness itself is a separate matter: a Codex or Cursor
  reviewer's own shell can still run files from the pull-request checkout
  while the credential is in its environment (see
  [Residual risk](#residual-risk)). A Claude or OpenCode reviewer has no
  shell.

## Trust boundaries by job

### run-agent.yml

| Job                       | Repository code       | Model credential                            | GitHub write                | Other tokens                                                                                                 |
| ------------------------- | --------------------- | ------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `resolve`                 | none                  | none                                        | none                        | `GITHUB_TOKEN`; for another repository `AGENT_CI_TARGET_TOKEN` and the read-only target token (checked here) |
| `setup`                   | runs `setup_command`  | none                                        | none                        | read-only target token for a private other repository                                                        |
| `agent` (`agent-job.yml`) | the agent works on it | the route's one credential, agent step only | none (`contents: read`)     | read-only target token; `AGENT_CI_PROXY_BASE_URL` for a pool route only                                      |
| `publish`                 | none (artifact only)  | none                                        | `contents`, `pull-requests` | `GITHUB_TOKEN` or `AGENT_CI_TARGET_TOKEN`; optional `AGENT_CI_NOTIFY_WEBHOOK`                                |

The agent job sits behind its own `workflow_call` boundary
(`agent-job.yml`), which declares only three secrets: the selected model
credential, the read-only target token and, for a pool route only, the
private proxy origin (`AGENT_CI_PROXY_BASE_URL`). So even
the runner that executes the agent holds no other model secret and no
write token.

The setup job's output is untrusted: the agent job downloads the archive by
artifact ID, checks its digest, and parses it itself (`agent-ci workspace
restore`), accepting only directories, regular files, in-tree links and hard
links, never `.git`, absolute paths, devices or setuid bits. The publish job
downloads the agent's artifact by ID and refuses it unless its content
digest matches the one the agent job recorded.

### pr-review.yml

| Job                               | Pull-request code                                                       | Model credential                                                                                                                               | GitHub write                  |
| --------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `gate`                            | no checkout                                                             | none                                                                                                                                           | label, reaction and one reply |
| `verify` (verify-review only)     | runs the `setup` command (with network) and the configured checks on it | none; the job's read-only `GITHUB_TOKEN` and Actions runtime token remain                                                                      | none (`contents: read`)       |
| `review-primary`, `review-second` | read-only checkout, no setup command, no repository skills              | every model secret the caller passes is on the runner; only the route's reaches the pass step, plus `AGENT_CI_PROXY_BASE_URL` for a pool route | none                          |
| `adjudicate`                      | no checkout; sources come from the git database API                     | the route's credential, tool-free Claude run                                                                                                   | none                          |
| `findings`                        | no checkout                                                             | none                                                                                                                                           | none (read-only token)        |
| `publish`                         | no checkout                                                             | none                                                                                                                                           | review and summary comment    |

Every job except `verify` also checks out the public agent-ci helpers with
the job's `GITHUB_TOKEN`.

### fan-out.yml and tools-update.yml

`fan-out.yml` calls `run-agent.yml` or `tools-update.yml` once per target,
so the same job boundaries apply per target. `tools-update.yml` never runs a
model and declares no model credential. Its run job runs the pinned OAT CLI
from npm (npm code) and holds the job's read-only `GITHUB_TOKEN` and, for a
private target in another repository, `AGENT_CI_TARGET_READ_TOKEN`; it holds
no write token. Its resolve and publish jobs match `run-agent.yml`'s.

## Token scoping

- **Static secret references only.** Each workflow picks the model secret
  for the resolved route with a fixed chain of comparisons
  (`credential == 'CLAUDE_CODE_OAUTH_TOKEN' && secrets.CLAUDE_CODE_OAUTH_TOKEN || ...`).
  A dynamic `secrets[...]` lookup would make the runner receive every secret
  the workflow holds.
- **One transport variable.** The selected secret reaches the agent step as
  `AGENT_CI_CREDENTIAL`; `agent-ci run --credential-from-env` moves it into
  the route's own variable. A caller cannot route a paid key into a
  subscription route's variable.
- **Write tokens stay out of code-running jobs.** `AGENT_CI_TARGET_TOKEN` is
  referenced only in the resolve and publish jobs. Code-running jobs check
  out another repository with `AGENT_CI_TARGET_READ_TOKEN`, which the
  resolve job refuses when it is the write token, a classic token with any
  scope, or able to write contents.
- **Checkouts do not persist credentials** (`persist-credentials: false`),
  except the publish jobs' target checkout: `agent-ci publish` pushes with
  that checkout's token, and the publish job runs no repository code.
- **The verify job gets no helper token.** agent-ci reaches it as a bundle
  the gate job uploads, checked against its sha256.
- **Pool routes** need an explicit opt-in, run in CI only on a self-hosted
  runner, and never for a Claude model (see
  [Harnesses and routing](harnesses-and-routing.md#policy)).
- **Private proxy origin.** The optional `AGENT_CI_PROXY_BASE_URL` secret
  replaces the loopback origin of pool routes. It is a secret, not a
  variable, so Actions masks the exact value in logs. It must be a bare
  origin in canonical form (`https://host[:port]`; plain `http` only for a
  loopback host), so every URL built from it contains the masked value. A
  message that shows only the host name, such as a DNS or connection
  error, is neither masked nor refused by the secret guard, so treat the
  host name as discoverable from logs and run artifacts. Workflows pass it only to the agent step, the reviewer
  passes and the adjudicator, and only for a pool route. With it set, the
  pool key travels to that host (over https unless it is a loopback
  host). The pool policy does not
  change.

## Isolated home and environment

Every harness process:

- starts from an environment allowlist (`PATH`, locale, `TZ`, `TMPDIR`,
  `USER`, `LOGNAME`, `SHELL`, `TERM`, `NO_COLOR` and certificate paths) plus
  only the credential variables the route names; every other credential
  variable is dropped, and adapter settings cannot add one;
- runs against an isolated home root (`HOME`, `XDG_*`, `CLAUDE_CONFIG_DIR`,
  `CODEX_HOME`) created for the run, so saved logins and user settings on
  the machine cannot select another account. The root must not overlap the
  workspace. Each run clears known login stores and any harness
  configuration that could run commands or widen permissions (hooks, rules,
  custom agents and commands) before the harness starts;
- has stdin closed, a deadline enforced with a process-group kill (2-second
  grace) and a 4 MiB output cap on stdout and stderr together; an output file
  read after the process exits (Codex's `-o` final answer) is held to the
  same cap, and a link at its path is refused;
- uses the read-only or edit posture listed in
  [Harnesses and routing](harnesses-and-routing.md#harnesses).

Workflows install skills into the per-job home root before the agent step.
Read-only runs never install repository skills; edit runs may
(`skills_source`), because their agent can already act on the repository.
The run fingerprints the installed skills and fails if an attempt changed
them.

A seeded login (`--seed-login`) is local only and refused in CI.

## Secret guard

Before writing results, agent-ci refuses (`E_SECRET_COPY`) a run whose
`run-result.json`, run log or changed files contain the exact value of any
known credential variable present in its environment (not only the
route's), including token-like values from a seeded login and
`AGENT_CI_PROXY_BASE_URL`: an output that echoes the private proxy origin
is refused like a credential. Values shorter than 8 characters are not
guarded. This catches accidental copies. It does not catch an encoded,
split or transformed value, and it cannot stop an agent that sends its
credential over the network.

## Publishing and path policies

- Publishing never force-pushes. Static branches live under `agent-ci/`,
  and agent-ci updates a branch or pull request only when its own
  publishing identity made the head commit or opened it, unless
  `adopt_branch` (or `reset` in fan-out) is set.
- The use-case presets publish only paths their policy allows (for example,
  docs-update refuses `.github/`, provider directories, MCP configuration
  and package manifests). The policy is checked against the change set and
  against the whole resulting pull request diff, so a deletion or revert
  outside the policy that the new tree would cause is refused too. `agent-ci preset list` prints every
  rule.
- A change set built on an older base than the static branch already
  publishes is refused (`E_PUBLISH_STALE_BASE`), so a delayed or re-run job
  cannot undo a newer base's changes.
- Changes to `.github/workflows/` are refused unless a caller passes
  `--allow-workflow-changes`, which no workflow does.

## PR review

- The gate is the only authority: the requester needs write, maintain or
  admin access; the pull request must be same-repository, open and not a
  draft; its author needs write access or an `allowed_pr_authors` entry.
  Fork pull requests never reach a credential.
- Consumers trigger from the default branch (`pull_request_target`,
  `issue_comment`), so a pull request cannot change its own review
  workflow, models or pin. A manual `workflow_dispatch` runs the caller at
  the ref the dispatcher selects; dispatch only from trusted refs.
- Commenter text travels only inside the digest-bound request and spec
  files, never through a step output or a shell script.
- The findings gate treats every reviewer artifact as untrusted and
  re-reads cited source itself. The adjudicator runs with every tool
  removed and may only drop or downgrade findings: it cannot add any or
  change protected ones (`high`, `critical`, or at or above
  `fail_on_severity`), and the findings gate enforces these limits again.

## Verify-review

- In Actions, checks run only in the verify job: no model credential and no
  helper token, a GitHub-hosted runner unless `verify_on_self_hosted`
  (meant only for ephemeral runners; agent-ci cannot check that), and never
  with `allow_pool`. The job's read-only
  `GITHUB_TOKEN` and Actions runtime token remain (see
  [Residual risk](#residual-risk)).
- The checks list comes from the default branch head or the caller's
  `verify_config_ref`, never from the pull request. Do not set
  `verify_config_ref` to the pull request's base branch
  (`github.base_ref`): its author can retarget the pull request to a branch
  they pushed.
- The optional `setup` command runs pull-request-controlled code (install
  scripts, lockfile resolution) with the network open. Only the checks lose
  the network, and only where isolation is available (a loopback-only
  network namespace on Linux, or the macOS sandbox, which allows only
  localhost).
- Each check runs with an environment allowlist that strips tokens, a
  `PATH` without checkout entries, a fresh copy of the tree, a deadline and
  a process-group kill, plus Linux namespaces where available.
- Locally, every `--verify` run requires `--verify-trust-pr-code`, because no
  local isolation is a credential boundary.

## Residual risk

These risks are accepted, with the conditions that would change that.

**Agents and reviewers**

- **An agent can leak its own credential on purpose.** An edit-mode agent
  can read its credential and could exfiltrate it through the network or an
  encoded output. The output guard catches only exact values. The job
  boundary limits the damage to that one credential.
- **Non-Claude reviewers can read process files and run checkout files.**
  Codex read-only mode keeps a shell that cannot write but can run commands,
  including scripts from the pull-request checkout, and read
  `/proc/self/environ`. Cursor's ask mode runs shell commands its classifier
  treats as read-only, in reviews and in read-only `run-agent` runs alike.
  OpenCode's read tool outside the workspace was not probed. A prompt
  injection in a pull request could make such a reviewer run pull-request
  code with the model credential in its environment, or try to publish an
  encoded credential in a finding.
  Claude's read-only posture refuses reads outside the workspace, and a pull
  request with links out of the checkout is refused. Requester and author
  write access is the trust boundary; prefer a Claude reviewer for
  repositories that accept outside contributions.
- **Cursor offers account connector tools.** Headless Cursor runs on a
  team-managed account were offered the account's cloud connector tools (mail- and
  calendar-style actions) whatever the isolated home contains. This affects
  every Cursor run and review route. Do not run Cursor on untrusted content
  until the account can disable connectors for API keys.
- **Repository symlinks.** A repository can commit a link to a sensitive
  path such as `/proc/self/environ` that a read-only agent then reads.
  Exact credential values are masked in outputs; encoded ones are not.

**Secrets and tokens**

- **Review jobs hold every model secret the caller passes.** The reviewer
  and adjudicator steps select one credential, but each of those runners
  receives every model secret the caller passes to `pr-review.yml`. The
  shipped caller template passes two (`CLAUDE_CODE_OAUTH_TOKEN` and
  `OPENCODE_API_KEY`). Pass only the secrets your review models use. The
  same holds for `AGENT_CI_PROXY_BASE_URL`, which the template also passes:
  every review and adjudicator runner holds it whatever the route, so pass
  it only if a review model uses a pool route.
- **One read token per fleet.** An agent on one target could read every
  private target the fleet's read token can read. The token's permissions
  beyond writing contents cannot be checked through the API, so a token with
  extra write permissions (for example, approving pull requests) would reach
  the agent job.
- **`setup_command` runs repository code** in the secret-free setup job, and
  an edit-mode agent can later run that code with the model credential in
  its environment. Point it only at trusted refs, never at fork pull
  requests.

**Verify-review**

- **The verify `setup` command has the network.** It runs the pull
  request's install scripts and lockfile with network access in the verify
  job, which is what makes the runtime-token and cache exposure below an
  exfiltration path.
- **Local verify has no credential boundary.** On macOS a check can read
  other processes' environments and the Keychain, and a lingering process
  could read a later harness's credential. On Linux, host service sockets
  (the systemd user manager, container daemons, D-Bus) stay reachable. Hence
  the mandatory `--verify-trust-pr-code`.
- **The verify job runs PR code in the default branch's Actions scope.** It
  can obtain that job's `ACTIONS_RUNTIME_TOKEN` (artifact uploads, cache
  writes that other default-branch workflows may restore) and its read-only
  `GITHUB_TOKEN`.
- **Reused self-hosted runners.** With `verify_on_self_hosted`, PR code can
  persist on a reused runner into later jobs that hold model secrets.
- **Evidence is an observation, not an attestation.** PR code controls the
  verify job and can make its own checks report anything; the gate only
  ensures citations match what the job recorded.

**Policy gaps**

- **Claude-only name check.** The Claude-only rule relies on each route's
  `family`. The defense-in-depth name check misses separator-less IDs such
  as `sonnet4.5`, and a Cursor `auto` route could select a Claude model.
  No such route exists in `models.yaml`; closing the gap is tracked in the
  project backlog, due before such a route is added.
- **Non-Claude skills access in edit mode.** Whether Codex, OpenCode and
  Cursor edit runs can write the installed skills was not probed. Any change
  to them fails the run through the skills fingerprint check.

**Supply chain and coverage**

- **Harness installs.** npm-installed harnesses pin only their top-level
  version; transitive dependencies resolve on each install, and Claude Code
  and OpenCode keep their install scripts. Codex installs with
  `--ignore-scripts`; the Cursor tarball is sha256-pinned. Read-only
  guarantees were probed against the pinned versions and must be re-probed
  when a pin changes.
- **Not exercised live yet:** a model-backed Actions run of `pr-review.yml`
  (a model-backed `fan-out.yml` docs-update run has passed), the
  default-branch review triggers,
  cross-repository fan-out with real target tokens, and a pool route on a
  self-hosted runner, including the Codex sandbox prerequisite on a
  self-hosted Linux host (see
  [Configuration and credentials](configuration.md#self-hosted-runners-and-the-proxy)). These paths are covered by unit and workflow
  structure tests.

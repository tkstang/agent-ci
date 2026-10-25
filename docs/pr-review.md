---
title: PR review
description: Request an AI pull-request review, how agent-ci gates and checks findings, and how verify-review adds check evidence.
---

# PR review

agent-ci reviews a pull request when someone with write access asks, checks
every finding against the pull request's real source, and publishes one
inline review plus one summary comment that later runs update in place. The
same pipeline runs in Actions (`pr-review.yml`) and on your machine
(`agent-ci review run`).

To set it up in a repository, copy `consumer-workflows/agent-ci-pr-review.yml`
(see [Workflows](workflows.md#consumer-templates)) and add the secrets from
[Configuration and credentials](configuration.md). The trust boundaries are
in [Security model](security-model.md#pr-review).

## Request a review

Only a user with write, maintain or admin access on the repository can
request a review, in one of three ways:

- Add the `agent-ci:review` label (or `agent-ci:verify-review`). agent-ci
  removes the label once the request is authorized, so adding it again
  starts a new request. A label carries no options.
- Comment on the pull request:

  ```txt
  /agent-ci-review [key=value ...] [--] [instruction]
  ```

  Options come only from the first line, as leading `key=value` tokens:
  `reviewer_model`, `second_reviewer`, `second_reviewer_model`,
  `adjudicator` and `adjudicator_model`. Booleans accept `true`, `1`, `on`,
  `false`, `0`, `off`. `--` ends the options; the rest of the line and every
  following line are the instruction to the reviewers. There is no quoting.
  `/agent-ci-verify-review` takes the same options and asks for
  [verify-review](#verify-review).

- Dispatch the caller workflow with `pr_number` and an optional `command`
  (the same text as a comment; blank means `/agent-ci-review`).

Every model a request selects must be in the caller's `allowed_models` and
resolve under the routing policy. A malformed comment or dispatch command,
or a disallowed model, gets one reply comment explaining the problem; a
label request that fails gets no reply; the workflow run fails and its job summary carries the
reason. Bot-authored commands and edited comments are ignored.

The gate then requires a same-repository, open, non-draft pull request whose
author has write access, or is a bot listed in `allowed_pr_authors`. Fork
pull requests are skipped and never reach a model credential. Accepted
requests get an `eyes` reaction.

### Triggers

Consumers trigger on `pull_request_target` (labeled), `issue_comment`
(created) and `workflow_dispatch`. GitHub runs these from the default
branch, so a pull request cannot change the caller file, the allowed models,
the review policy or the agent-ci pin it is reviewed under. Changes to the
caller take effect once merged. The gate also accepts `pull_request`
(labeled), only for this repository's pre-merge self-test.

## What a review does

```mermaid
flowchart LR
  accTitle: PR review jobs
  accDescr: The gate feeds the optional verify job and the reviewer passes; the passes feed the optional adjudicator and the findings gate; the findings gate feeds publish.
  gate[gate] --> verify["verify (verify-review only)"]
  gate --> primary[review-primary]
  verify --> primary
  gate --> second["review-second (optional)"]
  verify --> second
  primary --> adjudicate["adjudicate (optional)"]
  second --> adjudicate
  primary --> findings[findings]
  second --> findings
  adjudicate --> findings
  findings --> publish[publish]
```

1. **Gate** (`agent-ci review gate`, then `prepare`): authorizes the request,
   checks the models, captures the head commit every later job uses, and
   writes a digest-bound request, review spec and diff.
2. **Reviewer passes** (`review pass`): the primary reviewer, and the second
   reviewer when `second_reviewer` is on, read the pull request head
   read-only. Claude and Codex return schema-constrained output
   (`--json-schema`, `--output-schema`); OpenCode and Cursor return one JSON
   object in their final text. A pass whose answer fails validation gets one
   repair turn by resuming the session (Claude, Codex and OpenCode; not
   Cursor). Reviewer runs never execute a setup command or install
   repository skills, but a Codex or Cursor reviewer's own shell can still
   run commands in the checkout (see
   [Security model](security-model.md#residual-risk)).
3. **Adjudicator** (`review sources`, then `review adjudicate`), when
   `adjudicator` is on: a Claude route with every tool removed reads the
   candidate findings and their cited source, fetched without a checkout,
   and may drop or downgrade findings. It runs only on a harness with a
   verified tool-free mode, which today is Claude.
4. **Findings gate** (`review findings`): a deterministic check over every
   pass and the adjudication. It drops findings whose quoted source does not
   match the file at the captured commits, whose line range or diff position
   is invalid, or whose evidence cannot be recomputed; merges findings
   across passes by fingerprint at the highest surviving severity; skips
   findings already posted by earlier runs; applies the inline floor and the
   shared comment budget. It validates what the reviewers observed, not
   whether a finding is true.
5. **Publish** (`review publish`): posts one inline review and creates or
   updates the summary comment. It rechecks that the head has not moved and
   exits non-zero after publishing when the review is incomplete, the head
   moved, or `fail_on_severity` triggered.

Findings have a severity (`critical`, `high`, `medium`, `low`) and a
category (`correctness`, `security`, `performance`, `repo-rule`, `test`,
`maintainability`).

## Inputs

Selected `pr-review.yml` inputs; the workflow file has every input:

| Input                                                  | Default                        | Meaning                                                                                                                     |
| ------------------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `reviewer_model`                                       | `claude-haiku-4-5`             | Primary reviewer.                                                                                                           |
| `second_reviewer`, `second_reviewer_model`             | `false`, `grok-4.7`            | Run an independent second pass on every request.                                                                            |
| `adjudicator`, `adjudicator_model`                     | `false`, `claude-haiku-4-5`    | Run the adjudicator on every request (Claude routes only).                                                                  |
| `allowed_models`                                       | `claude-haiku-4-5`, `grok-4.7` | Models a request may select (newline- or comma-separated).                                                                  |
| `allowed_pr_authors`                                   | empty                          | Bot logins whose pull requests may be reviewed.                                                                             |
| `repo_guidance`, `repo_guidance_path`, `context_paths` | empty                          | Review guidance appended to agent-ci's baseline, a guidance file read from the PR head, and paths the reviewer reads first. |
| `fail_on_severity`                                     | empty                          | `critical`, `high`, `medium` or `low` fails the run after publishing; empty keeps reviews advisory.                         |
| `min_inline_severity`                                  | `medium`                       | Lowest severity posted inline; lower findings appear in the summary only.                                                   |
| `max_inline_comments`                                  | `10`                           | Inline comment budget per run, shared by every pass (0-100).                                                                |
| `verify`, `verify_config_ref`, `verify_on_self_hosted` | `false`, empty, `false`        | [verify-review](#verify-review) settings.                                                                                   |
| `allow_pool`, `runs_on`                                | `false`, `ubuntu-latest`       | Proxy-pool opt-in and runner label.                                                                                         |

## Review locally

`agent-ci review run` runs the same stages on your machine for a repository
you can push to:

```bash
export GITHUB_TOKEN   # a token for a user with write access; set it first
agent-ci review run --pr 42 --cwd /path/to/clone --model claude-haiku-4-5 --publish
```

- `--cwd` is a local clone whose `origin` is the repository (default
  `$GITHUB_REPOSITORY` for `--repo`). Each reviewer pass runs in a detached
  worktree at the captured head.
- Without `--publish` it gates, reviews and writes the gated result but
  posts nothing. With it, the review and summary are posted as the token's
  user.
- `--second-model` and `--adjudicator-model` turn those passes on;
  `--instruction` adds a request instruction; `--allow-pool` and
  `--seed-login` admit pool and login routes; `--out` keeps the stage
  artifacts.

The individual stages (`gate`, `prepare`, `verify`, `pass`, `sources`,
`adjudicate`, `findings`, `publish`) are the steps `pr-review.yml` runs.
`agent-ci review <stage> --help` prints a stage's flags, and
`agent-ci review run --help` prints every flag of the local run.

## Verify-review

Verify-review gives the reviewers recorded results of repository checks, so
a finding can cite "the tests fail" as evidence the gate can recompute. It
is off unless the caller sets `verify: true`.

1. **Configure checks** in `.github/agent-ci/checks.yaml` on the default
   branch:

   ```yaml
   version: 1
   setup:
     command: pnpm install --frozen-lockfile
     timeout_minutes: 10
   checks:
     - name: typecheck
       description: TypeScript type check
       command: node_modules/.bin/tsc --noEmit
       timeout_minutes: 10
     - name: unit-tests
       command: node_modules/.bin/vitest run
   ```

   Limits: 1-10 checks with unique names matching `[a-z][a-z0-9-]{0,39}`, a
   command of at most 2 KiB, a timeout of 1-30 minutes (default 10), a
   one-line description of at most 200 characters, and a 64 KiB file. The
   file is read from the head of the default branch, or of the branch the
   caller names in `verify_config_ref`, never from the pull request, so a
   pull request cannot add or change a check. Do not set
   `verify_config_ref` to the pull request's base branch
   (`github.base_ref`): its author can retarget the pull request to a
   branch they pushed. (This repository's own self-test does so only
   because its workflows exist only on the project branch before merge.)

2. **Request it** with `/agent-ci-verify-review` or the
   `agent-ci:verify-review` label.
3. **The verify job runs the checks** on the pull request head before any
   reviewer starts. It holds no model credential and no
   `AGENT_CI_SOURCE_TOKEN` (agent-ci arrives as a digest-pinned bundle from
   the gate job); the job's read-only `GITHUB_TOKEN` and Actions runtime
   token remain. It runs on a GitHub-hosted runner unless
   `verify_on_self_hosted: true` (ephemeral runners only), and it is refused
   in CI with `allow_pool: true`. The optional `setup` command runs first,
   in the pull request head, with the network open: it executes the pull
   request's install scripts and lockfile. Each check runs in a fresh copy of the
   prepared tree, with an environment allowlist that strips tokens, a `PATH`
   without checkout entries, its timeout and a process-group kill, a 1 MiB
   output capture with a masked 16 KiB tail, and, on Linux, isolated user,
   pid, mount and loopback-only network namespaces where the host allows
   them. Results go
   to `checks.json`; each has an evidence ID hashed from the check name,
   command, head commit, exit code and output digest.
4. **Reviewers read the results** through the `run_check` tool, an MCP
   server agent-ci serves from `checks.json`. The model can name a check;
   it cannot pass arguments or run a command. Only Claude and Codex reviewer
   routes can use it; OpenCode and Cursor are refused with
   `E_POLICY_HARNESS`.
5. **The findings gate** recomputes every cited evidence ID and drops
   unknown, forged or tampered citations. The summary shows each check's
   name and exit code, and the isolation the verify job reported.

Checks call installed tools directly (`node_modules/.bin/...`): each check
runs in a copy at another path, and a package manager that verifies its
install by path (for example pnpm's pre-run dependency check) would try to
reinstall without network.

### Verify-review locally

`agent-ci review run --verify` runs the checks on your machine before any
reviewer home or harness exists. The checks run the pull request's code as
you, and no local isolation is a credential boundary, so every local run
also needs `--verify-trust-pr-code`:

```bash
agent-ci review run --pr 42 --cwd /path/to/clone --model claude-haiku-4-5 \
  --verify --verify-trust-pr-code --publish
```

Use it only on pull requests whose code you would run yourself. agent-ci
still applies the isolation the host offers (Linux namespaces with a
read-only host, the macOS sandbox) and pins the harness binary, as hygiene.
Details are in [Security model](security-model.md#verify-review).

---
title: Workflows
description: The reusable GitHub Actions workflows, what each job may do, the consumer templates and the permissions a caller grants.
---

# Workflows

agent-ci ships reusable workflows (`on: workflow_call`) under
`.github/workflows/` and copy-in callers under `consumer-workflows/`. A
repository calls a reusable workflow at a pinned ref and passes the secrets
it needs. Every step with real logic is an `agent-ci` subcommand, so the YAML
stays thin and the logic is tested in TypeScript.

The workflow files are the reference for inputs: each input has a
description and default there. This page explains what each workflow does,
how its jobs divide authority, and how to call it. Secrets are described in
[Configuration and credentials](configuration.md); PR review has its own
page, [PR review](pr-review.md).

## Overview

| Workflow                  | Use it to                                                                                        | Caller permissions                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `run-agent.yml`           | Run one prompt with a chosen model and optionally publish a pull request and comment.            | `contents: write`, `pull-requests: write`                 |
| `agent-job.yml`           | Internal: the agent job of `run-agent.yml`. Do not call it.                                      | n/a                                                       |
| `pr-review.yml`           | Review a pull request on request and publish one review.                                         | `contents: read`, `issues: write`, `pull-requests: write` |
| `fan-out.yml`             | Run one maintenance preset across the repositories in a `targets.yaml`.                          | `contents: write`, `pull-requests: write`                 |
| `docs-update.yml`         | Update OAT documentation (`oat-docs-analyze`, then `oat-docs-apply`) and publish a pull request. | `contents: write`, `pull-requests: write`                 |
| `instructions-update.yml` | Update agent instruction files with the OAT skills and publish a pull request.                   | `contents: write`, `pull-requests: write`                 |
| `tools-update.yml`        | Run `oat tools update` (no model) and publish a pull request.                                    | `contents: write`, `pull-requests: write`                 |

GitHub checks the permissions a nested job requests against the original
caller. A caller must therefore grant `contents: write` and
`pull-requests: write` even when every target is another repository, because
the nested publish job asks for them.

## Pinning and helpers

Call a workflow as `uses: tkstang/agent-ci/.github/workflows/<file>@<ref>`
with a tag or commit SHA. Each job checks out the agent-ci helpers at that
same commit (`job.workflow_repository` at `job.workflow_sha`) and builds them
with the `.github/actions/setup-agent-ci` action, so there is no second pin.
The `agent_ci_repository` and `agent_ci_ref` inputs override this; leave
them empty so the helpers always match the pinned workflow. Because agent-ci is private, callers in other repositories pass
`AGENT_CI_SOURCE_TOKEN` for the helper checkout.

> [!NOTE]
> No release tag exists yet. The consumer templates pin `@main` with a
> comment; replace it with an agent-ci commit SHA when you copy one.

## run-agent.yml

Runs one prompt through the routed harness, then publishes. Its jobs hold
separate authority:

| Job                                 | Runs repository code | Holds                                                                                                                                                       | Does                                                                                                                                                                                                |
| ----------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve`                           | no                   | `GITHUB_TOKEN`, `AGENT_CI_SOURCE_TOKEN` (helper checkout); for another repository `AGENT_CI_TARGET_TOKEN` and `AGENT_CI_TARGET_READ_TOKEN`, which it checks | Resolves the target repository, the one commit every job checks out, the publish base and the pull request to comment on (`agent-ci targets resolve`), and the route (`agent-ci route`).            |
| `setup` (only with `setup_command`) | yes                  | no secret; the read-only target token for a private other repository                                                                                        | Runs `setup_command` in the target checkout and uploads the working tree without `.git`.                                                                                                            |
| `agent` (`agent-job.yml`)           | the agent            | the one model credential the route names, `AGENT_CI_SOURCE_TOKEN`, the read-only target token                                                               | Restores the setup tree (`agent-ci workspace restore`), installs the harness and skills, runs `agent-ci run`, and uploads `run-result.json`, `run-log.jsonl` and `changes.json` with their digest.  |
| `publish`                           | no                   | `contents: write` and `pull-requests: write` (`GITHUB_TOKEN`, or `AGENT_CI_TARGET_TOKEN` for another repository)                                            | Downloads the agent's artifact by ID, checks its digest, publishes the static-branch pull request and the PR comment (`agent-ci publish`), and sends the optional notification (`agent-ci notify`). |

Key inputs (all optional; see the file for every input):

| Input                                                      | Default                                 | Meaning                                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `model`, `harness`, `route`                                | empty                                   | What to run. Set `model` or `route`. See [Harnesses and routing](harnesses-and-routing.md).                                    |
| `prompt` or `preset`                                       | empty                                   | Your prompt, or a preset whose prompt agent-ci owns (`docs-update`, `instructions-update`). Set one.                           |
| `mode`                                                     | `read-only`                             | `read-only` or `edit`.                                                                                                         |
| `output_contract`                                          | `report`                                | `report`, `changes`, `issues` or `verdict`.                                                                                    |
| `use_case`                                                 | `generic-prompt`                        | Run identity; also names the default static branch `agent-ci/<use_case>`.                                                      |
| `target_repository`, `target_ref`                          | the calling repository and event commit | Run on and publish to another repository (needs `AGENT_CI_TARGET_TOKEN`).                                                      |
| `setup_command`                                            | empty                                   | Trusted setup, for example dependency installation, in the separate secret-free setup job.                                     |
| `skills_oat_packs`, `skills_source`                        | empty                                   | OAT packs installed into the per-job home; repository skills (edit runs only).                                                 |
| `publish_pr`, `publish_branch`, `publish_base`, `pr_title` | `false`, `agent-ci/<use_case>`          | Publish an edit run's changes as a pull request from a static branch.                                                          |
| `path_policy`                                              | the preset's policy                     | Refuse to publish changes outside a use-case path policy.                                                                      |
| `adopt_branch`                                             | `false`                                 | Replace the static branch content even if agent-ci did not make its head commit. History is kept; agent-ci never force-pushes. |
| `comment_pr`                                               | the triggering pull request             | Pull request to comment on.                                                                                                    |
| `allow_pool`                                               | `false`                                 | Allow a proxy-pool route (self-hosted runners only).                                                                           |
| `runs_on`                                                  | `ubuntu-latest`                         | Runner label for every job.                                                                                                    |
| `timeout_minutes`, `max_attempts`, `job_timeout_minutes`   | `30`, `2`, `60`                         | Agent deadline, attempts for transient failures, per-job timeout.                                                              |
| `publisher_login`                                          | `github-actions[bot]`                   | Login the publish token acts as; set it for a GitHub App token.                                                                |

Outputs: `status`, `pr_url` and `comment_url`.

Publishing details (`agent-ci publish`):

- The static branch must sit under `agent-ci/`. agent-ci updates an existing
  branch or pull request only when its own publishing identity made the head
  commit or opened it, unless `adopt_branch` is set.
- A new commit's parent is the branch head (plus the new base as a second
  parent when the base moved). An identical tree is reported as `unchanged`.
- A run built on an older base than the one the branch already publishes
  (a delayed or re-run job after a newer run published) is refused with
  `E_PUBLISH_STALE_BASE` and nothing is pushed: its tree would undo the newer
  base's changes. A base that cannot be related to the branch's recorded base
  (for example a rewritten base branch) is refused too, unless `adopt_branch`
  is set. Rerun the agent on the current base branch.
- The path policy and the workflow-file rule apply to the whole pull request
  diff (the branch head against its merge base with the base branch), not only
  to the run's change set. The check runs before anything is pushed and before
  the pull request or comment is created or updated, also when the branch is
  `unchanged` (the same branch can be a different diff against another base).
- Changes under `.github/workflows/` are refused; `GITHUB_TOKEN` cannot push
  them.

Edit runs that may retry run every attempt in a fresh copy of the repository
and promote only the successful attempt's changes.

## pr-review.yml

Reviews a pull request when someone with write access asks, through the
`agent-ci:review` label, a `/agent-ci-review` comment or a manual dispatch,
and publishes one inline review plus a summary comment. Its jobs, triggers,
inputs and verify-review mode are described in [PR review](pr-review.md).

## fan-out.yml and targets.yaml

`fan-out.yml` runs one preset across the repositories in the caller's
`targets.yaml`:

1. The `targets` job runs `agent-ci targets matrix`. It validates the file
   (schema, unique IDs and repositories, `allowedOwners`, and that each
   target's model resolves under the CI routing policy) and emits at most
   `max_targets` (default and maximum 50) matrix entries.
2. For `docs-update` and `instructions-update` it calls `run-agent.yml` once
   per target; for `tools-update` it calls `tools-update.yml`, which needs no
   model credential.
3. `max_parallel` (default 4) bounds how many targets run at once.

Inputs: `preset` (required), `target` (`all`, a target ID or an
`owner/name`), `reset` (one target only; replaces its static branch
content), `targets_file` (default `targets.yaml`), `base` and `model`
(override every selected target), `allow_pool`, `runs_on`,
`publisher_login`. Fork pull-request events are refused.

A minimal `targets.yaml`:

```yaml
version: 1
allowedOwners: [my-org]
defaults:
  base: main
  model: claude-haiku-4-5
targets:
  - id: web-app
    repository: my-org/web-app
  - id: docs-site
    repository: my-org/docs-site
    useCases: [docs-update]
    inputs:
      setupCommand: pnpm install --frozen-lockfile --ignore-scripts
```

A target may set `base`, `model`, `harness`, `route`, `mode`, `useCases`
(default: every preset) and `inputs` (`setupCommand`, `skillsOatPacks`,
`timeoutMinutes` 1-360, `maxAttempts` 1-5, `oatCliVersion`,
`dependencyPolicy`, `prTitle`, `publishBranch` under `agent-ci/`).
`targets.example.yaml` documents every field. Validate a file locally:

```bash
agent-ci targets validate --file targets.yaml
agent-ci targets matrix --preset docs-update --file targets.yaml
```

For running a fleet from its own repository, see
[Using agent-ci from another repository](fleet-repo.md).

## Use-case wrappers

The wrappers call `run-agent.yml` or run the OAT CLI with a fixed prompt,
path policy and static branch. Consumers call them and never copy their
prompts.

| Workflow                  | Preset                | Kind                    | Default branch                           | OAT packs   | Publishes only                                                                                                                                                                                                                                                                          |
| ------------------------- | --------------------- | ----------------------- | ---------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs-update.yml`         | `docs-update`         | agent, edit mode        | `agent-ci/oat-docs-update`               | `core,docs` | Markdown and images under any `docs/` directory plus its named navigation files, root Markdown files, `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`, the OAT tracking file and OAT analysis notes; never `.github/`, provider directories, MCP configuration or package manifests                 |
| `instructions-update.yml` | `instructions-update` | agent, edit mode        | `agent-ci/oat-agent-instructions-update` | `core,docs` | `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` files, rule files under `.claude/rules`, `.agents/rules`, `.windsurf/rules` and `.cursor/rules`, GitHub Copilot instruction files, the OAT tracking file and OAT analysis notes; never settings, hooks, MCP configuration, skills or workflows |
| `tools-update.yml`        | `tools-update`        | deterministic, no model | `agent-ci/oat-tools-update`              | none        | the OAT-managed directories (`.oat`, `.cursor`, `.claude`, `.agents`, `.codex/agents`) and root `.gitignore`/`.gitattributes`; `package.json` and lockfiles only with `dependency_policy: include-lockfile`                                                                             |

`agent-ci preset list` prints each preset with its exact path policy rules.
The two agent wrappers take the same model, route, target, setup and publish
inputs as `run-agent.yml` (with `base` in place of `target_ref` and
`publish_base`). `tools-update.yml` takes `oat_cli_version` (default
`latest`; pin an exact version for reproducible runs) and
`dependency_policy` (`skills-only` or `include-lockfile`).

## Consumer templates

Copy one of these into the calling repository's `.github/workflows/`, pin
the `uses:` ref, and add the secrets it lists.

| Template                                       | Calls                                       | Triggers                                                                        | Secrets                                                                                          |
| ---------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `consumer-workflows/agent-ci-run.yml`          | `run-agent.yml` (edit mode, publishes a PR) | `workflow_dispatch` with `prompt` and `model`                                   | `AGENT_CI_SOURCE_TOKEN`, one model secret                                                        |
| `consumer-workflows/agent-ci-pr-review.yml`    | `pr-review.yml`                             | `pull_request_target` (labeled), `issue_comment` (created), `workflow_dispatch` | `AGENT_CI_SOURCE_TOKEN`, the reviewer model secrets                                              |
| `consumer-workflows/agent-ci-docs-update.yml`  | `docs-update.yml`                           | weekly schedule, `workflow_dispatch`                                            | `AGENT_CI_SOURCE_TOKEN`, one model secret                                                        |
| `consumer-workflows/agent-ci-tools-update.yml` | `tools-update.yml`                          | weekly schedule, `workflow_dispatch`                                            | `AGENT_CI_SOURCE_TOKEN`                                                                          |
| `consumer-workflows/agent-ci-fleet.yml`        | `fan-out.yml`                               | three weekly schedules, `workflow_dispatch` with `preset`, `target`, `reset`    | `AGENT_CI_SOURCE_TOKEN`, `AGENT_CI_TARGET_TOKEN`, `AGENT_CI_TARGET_READ_TOKEN`, one model secret |

`actionlint` checks every template in CI.

## This repository's self-tests

Three callers exercise the workflows on pull requests in `tkstang/agent-ci`
with the `fake` harness and no model secret:
`agent-ci-selftest.yml` (`run-agent.yml`, including the setup handoff and a
static pull request), `agent-ci-fanout-selftest.yml` (`fan-out.yml` against
this repository) and `agent-ci-review-selftest.yml` (`pr-review.yml` and
verify-review, triggered by the review labels). They use `pull_request`
because the workflows reach the default branch only when they merge.

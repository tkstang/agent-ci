---
title: Using agent-ci from another repository
description: Run agent-ci for your other repositories from one fleet repository, and add PR review to each reviewed repository.
---

# Using agent-ci from another repository

agent-ci is a set of reusable workflows. Other repositories call them; they
do not copy agent-ci's code. This guide sets up the recommended layout for a
personal account:

- **A fleet repository**, a separate repository you own, holds
  `targets.yaml`, the schedules and the secrets, and runs the maintenance
  presets (docs update, instructions update, tools update) across every
  target.
- **Each repository that wants PR review** carries its own small caller,
  because a review runs in the reviewed repository.

Read [Configuration and credentials](configuration.md) first; this guide
refers to its secrets.

## 1. Let your repositories use agent-ci

agent-ci is private, so two things are needed once:

1. In `tkstang/agent-ci`, set Settings, Actions, General, Access to allow
   repositories owned by the user. Without it, a `uses:` reference from
   another repository fails.
2. Create a fine-grained token with Contents: Read-only on
   `tkstang/agent-ci` and store it as `AGENT_CI_SOURCE_TOKEN` in every
   repository that calls agent-ci. Each job uses it to check out the
   agent-ci helpers at the pinned commit.

## 2. Create the fleet repository

1. Create a private repository, for example `<you>/agent-ci-fleet`.
2. Add `targets.yaml` at its root. List each repository to maintain:

   ```yaml
   version: 1
   allowedOwners: [<you>]
   defaults:
     base: main
     model: claude-haiku-4-5
   targets:
     - id: web-app
       repository: <you>/web-app
     - id: notes
       repository: <you>/notes
       useCases: [docs-update]
   ```

   `allowedOwners` makes agent-ci refuse a target outside your account.
   Validate the file from an agent-ci checkout with
   `agent-ci targets validate --file /path/to/targets.yaml`.

3. Copy `consumer-workflows/agent-ci-fleet.yml` to
   `.github/workflows/agent-ci-fleet.yml`. It runs `docs-update` on Mondays,
   `tools-update` on Tuesdays and `instructions-update` on Wednesdays, and
   can be dispatched for one preset and one target. Replace the `@main` in
   its `uses:` line with an agent-ci commit SHA.
4. Store the secrets in the fleet repository:
   - `AGENT_CI_SOURCE_TOKEN` (step 1);
   - `AGENT_CI_TARGET_TOKEN`: Contents and Pull requests read and write on
     every target repository;
   - `AGENT_CI_TARGET_READ_TOKEN`: Contents read-only on every private
     target;
   - the model secret of every route your targets use, for example
     `CLAUDE_CODE_OAUTH_TOKEN` for `claude-haiku-4-5` and `OPENCODE_API_KEY`
     for `grok-4.7`. The template passes only `CLAUDE_CODE_OAUTH_TOKEN`;
     add a `secrets:` line for each other one (validation does not check
     this). `tools-update` needs none;
   - optionally `AGENT_CI_PROXY_BASE_URL`, only for pool routes (self-hosted
     runner, `allow_pool: true` and `AGENT_CI_PROXY_API_KEY`); see
     [Configuration and credentials](configuration.md).
5. Allow GitHub Actions to create pull requests in the fleet repository's
   Actions settings only if a target is the fleet repository itself; other
   targets are published with `AGENT_CI_TARGET_TOKEN`.

The fleet caller grants `contents: write` and `pull-requests: write`, because
GitHub checks the nested publish jobs' permissions against it, even though
the writes to other repositories use the target token.

Run it once by hand from the Actions tab (preset `tools-update`, target one
repository) before relying on the schedule. Each target gets a static branch
such as `agent-ci/oat-docs-update` and one pull request that later runs
update.

> [!NOTE]
> Runs against other repositories (the target and read tokens) are covered
> by unit and workflow structure tests but have not yet run live; the live
> fan-out evidence targets `tkstang/agent-ci` itself.

### Mixed trust

One read token serves every target, so an agent working on one target could
read every private target that token can read. Keep repositories of
different trust in separate fleet repositories with their own tokens. See
[Security model](security-model.md#residual-risk).

## 3. Add PR review to a repository

PR review cannot run from the fleet repository: the gate reviews pull
requests of the repository the workflow runs in, and the triggering label or
comment happens there. For each repository that wants reviews:

1. Copy `consumer-workflows/agent-ci-pr-review.yml` to
   `.github/workflows/agent-ci-pr-review.yml` and pin its `uses:` ref to an
   agent-ci commit SHA.
2. Store `AGENT_CI_SOURCE_TOKEN` and the reviewer model secrets the caller
   passes (the template passes `CLAUDE_CODE_OAUTH_TOKEN` and
   `OPENCODE_API_KEY`, plus the optional pool-route
   `AGENT_CI_PROXY_BASE_URL`; remove the ones you do not use).
3. Create the `agent-ci:review` label (and `agent-ci:verify-review` if you
   set `verify: true`).
4. Merge the caller to the default branch. `pull_request_target` and
   `issue_comment` run from there, so reviews start working only after the
   merge.

Request a review as described in [PR review](pr-review.md#request-a-review).

## 4. Run one repository's own maintenance instead

A repository that should maintain only itself can skip the fleet and copy
`consumer-workflows/agent-ci-docs-update.yml` or
`consumer-workflows/agent-ci-tools-update.yml` directly. Those run against
the calling repository with `GITHUB_TOKEN`, so they need
`AGENT_CI_SOURCE_TOKEN`, the model secret (docs update only) and the Actions
setting that lets workflows create pull requests.

## Updating agent-ci

Callers pin a commit, so agent-ci changes reach a repository only when its
`uses:` ref changes. The helpers always match that ref. To update, change
the SHA in each caller, starting with the fleet repository.

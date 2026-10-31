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

agent-ci is public. Pin its reusable workflows to a released version tag
such as `v0.1.0`, or a reviewed full commit SHA in the `uses:` reference. The helpers are checked out at that same commit with the
job's `GITHUB_TOKEN`; no separate source token or agent-ci Actions access
setting is needed.

## 2. Create the fleet repository

1. Choose a caller for the targets' trust and visibility. Use a public
   fleet on GitHub-hosted runners for public targets, or a private fleet on
   admitted self-hosted runners for private targets and subscription-pool
   routes. Keep private targets in the private fleet while artifact encryption
   remains unimplemented; output suppression does not protect artifacts.
2. Configure the targets in a file, or use the JSON-only private template
   described below. For a file, add `targets.yaml` at the caller root:

   ```yaml
   version: 1
   allowedOwners: [<you>]
   defaults:
     base: main
     model: claude-haiku-5-5
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

3. Copy `consumer-workflows/agent-ci-fleet.yml` for the public hosted caller,
   or `consumer-workflows/agent-ci-private-fleet.yml` for the private pool
   caller, into `.github/workflows/`. The public template schedules
   `docs-update` Mondays, `tools-update` Tuesdays and `instructions-update`
   Wednesdays. The private template is manual-only until runner admission
   and scheduled-event policy are reviewed; replace its label placeholder
   with the complete admitted label array. Both templates pin `v0.1.0`;
   review later releases before updating them. For the pool
   template, set each agent target's model to an admitted pool alias (for
   example `gpt-6.1-sol-high`) instead of the personal example above. It
   starts in JSON-only mode: set the repository Actions variable
   `AGENT_CI_TARGETS_JSON` to a target array whose entries include `base`
   and `model`. To use the YAML defaults/allowlist instead, change its
   `targets_file: ''` to `targets_file: targets.yaml`; the variable then
   appends to that file. An empty JSON-only list fails selection.
4. Store the secrets in the fleet repository:
   - `AGENT_CI_TARGET_TOKEN`: Contents and Pull requests read and write on
     every target repository;
   - `AGENT_CI_TARGET_READ_TOKEN`: Contents read-only on every private
     target;
   - the model secret of every route your targets use, for example
     `CLAUDE_CODE_OAUTH_TOKEN` for `claude-haiku-4-5` and `OPENCODE_API_KEY`
     for `grok-4.7`. The public template passes only
     `CLAUDE_CODE_OAUTH_TOKEN`; add each required credential explicitly
     (validation does not check presence). The private pool template maps
     `AGENT_CI_PROXY_API_KEY` for Codex and the same existing key into
     `ANTHROPIC_AUTH_TOKEN` for Claude Code. `tools-update` needs none;
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

### Combine file and JSON targets

`agent-ci targets validate` and `agent-ci targets matrix` accept
`--targets-json '<JSON array>'`. Entries are appended after the YAML targets
and inherit the file's `defaults`; `allowedOwners` applies to both sources.
For example:

```bash
agent-ci targets validate --file targets.yaml \
  --targets-json '[{"id":"extra","repository":"<you>/extra"}]'
```

The JSON value must be an array of target entries with the same fields as
YAML entries. Blank or whitespace-only JSON adds nothing. Input is limited
to 256 KiB of UTF-8 JSON, and the combined list must contain 1–50 targets.
Duplicate IDs or repositories (case-insensitive for repositories) fail;
entries never replace or deduplicate another entry. The full merged list
must pass schema and owner validation even when selecting only one target.
Routing policy is checked for the selected targets and preset; `validate`
checks every preset each target participates in.

Omitting `--file` still requires `targets.yaml`; an explicitly named missing
file also fails. To supply only JSON, pass `--file ''` and include each
target's required settings, such as `base` and an agent preset's model.
A YAML file may hold only policy and defaults with `targets: []` when JSON
supplies entries. An empty combined list fails validation.

### Mixed trust

One read token serves every target, so an agent working on one target could
read every private target that token can read. Keep repositories of
different trust in separate fleet repositories with their own tokens. See
[Security model](security-model.md#residual-risk).

### Private target output

Set `private: true` on a YAML or JSON target to suppress its command
payloads, model summary, file lists and diagnostics in agent-ci's stdout and
stderr. The workflow also suppresses setup-command stdout/stderr and review
step-summary writes. Success envelopes contain only `{private: true}`;
failures retain their machine-readable code and exit status with generic
text. `GITHUB_OUTPUT` remains available to the workflow. For a direct
reusable caller, set `private_target: true`; on `fan-out.yml` that input
applies to all selected targets. The private fleet template enables it.
Locally, use `AGENT_CI_PRIVATE_TARGET=true` for the same CLI behavior.

This is output control, not repository anonymity or artifact encryption.
GitHub can show target identities and configuration in matrix/job metadata,
checkout logs, inputs, environment displays and artifact names. Uploaded
artifacts still contain full target trees, prompts and results in plaintext;
anyone who can download them can read them. Keep private runs in a private
caller with an appropriate readership. Publishing still writes the intended
pull request or comment to the target repository. Full authenticated artifact
transport remains open pending its credential-boundary design.

## 3. Add PR review to a repository

PR review cannot run from the fleet repository: the gate reviews pull
requests of the repository the workflow runs in, and the triggering label or
comment happens there. For each repository that wants reviews:

1. Copy `consumer-workflows/agent-ci-pr-review.yml` to
   `.github/workflows/agent-ci-pr-review.yml`. Its `uses:` ref pins
   `v0.1.0`; review later releases before updating it.
2. Store the reviewer model secrets the caller passes (the template passes
   `CLAUDE_CODE_OAUTH_TOKEN` and `OPENCODE_API_KEY`, plus the optional pool-route
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
the calling repository with `GITHUB_TOKEN`, so they need only the model
secret (docs update only) and the Actions setting that lets workflows create
pull requests.

## Updating agent-ci

Callers pin a commit, so agent-ci changes reach a repository only when its
`uses:` ref changes. The helpers always match that ref. To update, change
the SHA in each caller, starting with the fleet repository.

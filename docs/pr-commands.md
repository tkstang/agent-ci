---
title: PR commands
description: Run a task from a trusted PR comment, use repository skills, verify the result and push a commit to the existing branch.
---

# PR commands

Use `pr-agent.yml` to run a task on an existing pull request. The workflow
appears as `[agent-ci] Run PR comment prompt` in GitHub Actions. It
checks out its exact head, gives the task to the configured agent, verifies
the resulting tree and pushes a commit to the same branch. It posts a
summary on that PR and does not open another pull request.

## Set up a consumer

1. Copy [agent-ci-pr-command.yml](../consumer-workflows/agent-ci-pr-command.yml)
   into the consumer repository's `.github/workflows/` directory. Replace
   its `uses:` ref with a reviewed agent-ci commit SHA or released version,
   then merge the caller into the repository's default branch.
2. Configure `model` and `allowed_models`, and pass only the credential
   the configured routes need. Optional `model_profiles` let comments choose
   among caller-defined mappings; they cannot supply arbitrary routes or credentials.
   See [Configuration and credentials](configuration.md).
3. Set `setup_command` if the agent needs dependency preparation. It runs
   in a separate job and must leave tracked files unchanged. Ignored
   dependency directories can be prepared here; a modified lockfile or
   other tracked file causes execution to stop before the agent starts.
4. Set the required `check_command`. Verification runs against a fresh
   reconstruction of the resulting tree on the verification runner, which
   defaults to `ubuntu-latest`. It
   does not inherit the setup job's dependencies, so include any required
   installation in the check command itself. For example:

   ```yaml
   check_command: pnpm install --frozen-lockfile && pnpm run typecheck && pnpm run lint && pnpm test
   ```

The caller grants `contents: write` and `pull-requests: write` so its
publisher can update the branch and post a summary. Agent execution has
read-only GitHub permissions. The optional publishing token and the effect
on subsequent CI are covered in
[Configuration and credentials](configuration.md#pr-command-publishing-token).

## Select runners

`runs_on` selects the runner for authorization, dependency setup, agent execution
and publication. `verify_runs_on` independently selects the final verification
runner. Both default to `ubuntu-latest` and accept either a runner label or a
JSON array of labels encoded as a string.

A consumer using self-hosted Linux ARM64 runners can set both inputs:

```yaml
with:
  runs_on: '["self-hosted","linux","ARM64","your-private-runner-label"]'
  verify_runs_on: '["self-hosted","linux","ARM64","your-private-runner-label"]'
```

Each self-hosted job must receive a fresh isolated environment. A persistent
runner shared by repository code, agent execution and publication can retain
files or processes across jobs and invalidate their credential separation.
Verification receives no model or write credential and still requires its own
checkout and dependency installation. Runner selection does not change those
job permissions or artifact digest checks.

## Request a task

Post a new top-level comment on an open PR:

```text
/agent-ci address the review feedback and fix the merge conflicts
```

The mention form also works:

```text
@agent-ci fix the failing integration test
```

These are PR conversation comments delivered as `issue_comment` events,
not inline review comments. The command must start the comment. Editing an
existing comment does not start a run; post a new command instead. Commands
such as `/agent-ci-review` belong to the separate
[PR review](pr-review.md) workflow.

Once the gate accepts the command, agent-ci adds an eyes reaction (👀) to
that comment to acknowledge it. A failed reaction does not stop the accepted
task. Ignored or unauthorized comments receive no reaction.

The requester must currently have write, maintain or admin access. The PR
must be open and its head and base must belong to the calling repository.
Draft PRs are allowed. Its human author also needs current write access;
bot authors need an exact `allowed_pr_authors` entry. The workflow refuses
to write a head branch that is the repository's default branch or the PR's
base branch. Fork PRs never reach the model credential.

The gate pins the actual head and base branch refs rather than cached commit
SHAs in PR metadata, then fetches its description,
discussion, submitted reviews and inline review comments. This context is
bounded and supplied as untrusted observations. The REST comment listing
includes both resolved and unresolved feedback; it does not identify thread
resolution state. The command does not automatically resolve review threads.

## Choose a model profile

Agent-ci defines the profile configuration and resolves it. Each consumer
passes its required default `model` and optional `model_profiles` YAML to
`pr-agent.yml`. The supported profile names are `cost`, `balance` and
`intelligence`. Each configured profile requires `model` and may pin
`harness` or `route` using agent-ci's existing routing table.

For example, a consumer using Sol 6.1 High through Codex can configure:

```yaml
with:
  model: gpt-6.1-sol-high
  harness: codex
  allowed_models: gpt-6.1-sol-high
  model_profiles: |
    balance:
      model: gpt-6.1-sol-high
      harness: codex
  allow_pool: true
secrets:
  AGENT_CI_PROXY_API_KEY: ${{ secrets.AGENT_CI_PROXY_API_KEY }}
  AGENT_CI_PROXY_BASE_URL: ${{ secrets.AGENT_CI_PROXY_BASE_URL }}
```

This route uses the subscription proxy pool. On a hosted runner, the proxy
base URL must be a reachable HTTPS endpoint. See
[Configuration and credentials](configuration.md) for pool access and secret
setup. Add the required `check_command` and other consumer settings as
shown above.

Select a profile at the start of the task:

```text
/agent-ci --model-profile=balance resolve review comments
```

`--model-profile balance` also works. Without the option, agent-ci uses the
required default `model`, `harness` and `route`. A profile supplies a complete
selection and does not inherit the default harness or route. Every configured
model, including the default, must appear in `allowed_models`. Unknown config
fields, unsupported names and requests for unconfigured profiles fail before
agent execution. There is no automatic fallback between profiles, and the
names do not imply a provider or an automatic model router.

Options must precede the prompt. Once the prompt begins, text such as
`--model-profile=cost` stays part of the prompt. Use `--` to start a prompt
with a literal option. Direct `--model` selection is reserved for a future
version and is currently rejected as a leading option.

Native skill invocations remain in the task text:

```text
/agent-ci --model-profile=balance use $fix-ci and then $address-feedback
```

Use the skill syntax supported by the selected harness, as described below.

## Use repository skills

Set `skills_source` to the directory containing the skills in the checked-out
PR head:

```yaml
skills_source: .github/agent-ci/skills
```

For example, that checkout could contain
`.github/agent-ci/skills/resolve-review/SKILL.md`. The installer copies the
skills into the run's isolated home and provider views. It uses the pinned
PR checkout, not the latest default branch or a directory from the runner's
own home. `skills_oat_packs` can additionally install selected OAT packs.

Use the selected harness's native invocation syntax. A Claude task can
start with a slash command:

```text
/agent-ci /resolve-review address the review feedback
```

A harness that recognizes `$name` references can receive:

```text
/agent-ci use $fix-ci and then $address-feedback
```

agent-ci removes its command prefix and preserves the remaining task. It
does not parse skill names, create a skills array, or reinterpret ordinary
references such as PHP `$response`. Claude receives the raw task as its
user prompt, with agent-ci's execution instructions in an appended system
prompt so a leading slash command stays at the start.

One local live probe through `agent-ci run` with Cursor CLI
`2026.11.05-86047df` and `grok-4.7-low` completed two installed skills in the
requested order with `/ci-probe-first and then /ci-probe-second`. The
resulting file contained the expected ordered output from both skills.
This does not qualify other CLI versions or Claude's user-only slash-skill
path. Discoverability, user-only invocation flags and invocation of several
skills depend on the harness. A phrase such as "and then" asks that
harness to perform the work in order; agent-ci does not enforce a separate
skill chain. Skills that require interactive approval or their own Git,
GitHub or publishing operations may not fit the unattended run. The agent
must leave checkout, commit and push operations to agent-ci.

## Verification and publication

The agent edits files without a GitHub write token. A separate job rebuilds
the final tree and runs `check_command` without model or write credentials.
Only successful verification permits publication.

For textual merge conflicts, agent-ci computes a merge of the pinned PR
head and base with HEAD unchanged, then lets the agent resolve its files.
Verification and publication independently recompute that merge baseline,
which preserves cleanly merged base files as well as the agent's edits.
The final commit has the original PR head as its first parent and the pinned
base as its second parent. Non-conflicting base updates are left alone.
Binary, symlink, submodule and delete/modify conflicts are not supported by
this first version.

The publisher rechecks the open PR's repository, branches and both pinned
commits. It proves that the generated commit retains the pinned head as its
first parent, then pushes with an exact-head lease. The lease permits only
that expected branch state; it does not permit replacing captured history.
If the head or base moved, publication stops with `E_PR_RUN_STALE_HEAD`.
Post a fresh command to run against the updated PR. Changes to
`.github/workflows/` or `.gitmodules` are refused.

Runs are serialized per repository, including dispatch replays, before the
gate captures a PR snapshot. If a published change is unwanted, revert the
generated commit through the repository's normal review process.

## Replay a real comment for a pre-merge test

GitHub loads `issue_comment` workflows from the default branch. A caller
that exists only in a feature branch cannot receive that event yet. Once
the caller is registered, its `workflow_dispatch` input accepts the numeric
`comment_id` of a real PR command. Dispatch only a reviewed, trusted ref.

The gate fetches that comment itself. Its author must be the dispatcher,
it must be unedited, and the same current-permission and PR checks still
apply. Dispatch inputs cannot supply a prompt, actor, PR number or commit
SHA to bypass those checks.

For agent-ci's own pre-merge consumer test, the already registered
`agent-ci-selftest.yml` workflow calls the local reusable workflow from the
selected feature ref with the real comment ID. A new standalone workflow
may require default-branch registration before GitHub allows dispatch.
This bootstrap tests execution and publication from an actual comment;
default-branch event delivery requires a separate test after the caller is
merged.

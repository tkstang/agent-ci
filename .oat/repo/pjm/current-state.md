# OAT Current State

This file is the active operating picture and lives under `pjm/` (the
operational layer), not `reference/`. To reduce cross-worktree conflicts, keep
edits append-mostly and scoped to the section you own; avoid rewriting whole
sections another branch may also touch.

## Canonical References

<!-- List durable repo references, source-of-truth docs, dashboards, or processes here.
Decisions live in reference/decisions/ (one file per record); link them rather than
copying their content here. -->
- `models.yaml` — the routing table and its policy notes.
- `AGENTS.md` — toolchain, non-negotiables, definition of done.
- Decisions: `reference/decisions/index.md` (routing policy: DR-261025-route-models-through-a-checked; harness CLIs: DR-261025-run-agents-through-harness; tsrs: DR-261025-use-tsrs-instead-of-tsc).
- Active delivery: OAT project `agent-ci-v1` (brief mode, synced project files).

## What's Implemented

<!-- Summarize shipped capabilities and important repo conventions here. -->
As of 2026-10-25 (agent-ci-v1 phase p01, branch `feat/agent-ci-v1`, not merged):

- **CLI** `agent-ci` with `run`, `models`, `doctor`, `validate` (one JSON envelope on stdout, `E_*` codes, logs on stderr; `--json` accepted). New workflow-step logic becomes a `CommandSpec` in `src/commands/`.
- **Harness adapters** for `claude`, `codex`, `opencode`, `cursor`, plus a credential-free `fake` harness. Shared spawn: stdin always `/dev/null`, process-group kill at the deadline, output cap. Child environment = base allowlist + only the route's named credentials. One isolated home root per run (`HOME`, `XDG_*`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`), seedable with skills and, locally only, an existing login (known login stores are cleared at the start of every run; seeded-login token values are guarded like credentials). OpenCode read-only deny rules were verified live (edit, bash, shell, webfetch, websearch denied).
- **Routing** from `models.yaml` with policy: every route declares a model `family`; Claude-family models only on claude; no subscription → paid or → work-account fallback; `pool` needs `--allow-pool` and is refused under CI.
- **Run core**: prompt builder, supervisor (transient retries within one deadline), Zod RunResult contracts (report, changes, issues, verdict), secret guard, `run-result.json` + `run-log.jsonl`. Only changes made during the run count as `changedFiles`.
- **Verified live (2026-10-25)**: one cheap run per harness through `agent-ci run` (claude pool, codex pool, opencode personal login, cursor work account); with an empty home root and no route credential every harness failed authentication.
- **Toolchain**: `tsrs` for typecheck and build (pinned pre-release), Oxc, Vitest, Zod 4, `yaml`.
- **AI pull-request review (p03)**: `pr-review.yml` (workflow_call) and `agent-ci review <stage>`; consumers trigger on `pull_request_target` labeled `agent-ci:review`, `/agent-ci-review` comments or dispatch, behind a gate (requester write+, same-repository open non-draft PRs, author write+; forks skipped). Reviewer passes run read-only through the run core as structured runs (schema or prompt-and-parse, one repair turn by session resume on claude/codex/opencode); the adjudicator runs only on Claude with every tool removed; a deterministic findings gate re-reads cited source through the git database API (trees and blobs); one inline review plus an updatable summary. `agent-ci review run` does a whole review locally. Decisions DR-261025-trigger-pr-reviews-from and DR-261025-run-the-pr-review-adjudicator.

- **verify-review (p04)**: the `/agent-ci-verify-review` command, the `agent-ci:verify-review` label, and `agent-ci review run --verify`. The checks in `.github/agent-ci/checks.yaml` (base commit) run where no model credential exists: the `verify` job of `pr-review.yml` (`verify` input, default off; no secret, helpers from a sha256-pinned bundle), or locally before the reviewer starts. Each runs in a fresh copy with no credential variables, a PATH without checkout entries, a deadline, output caps and a group kill, isolated by Linux user, pid, mount and loopback-only net namespaces or macOS sandbox-exec (local runs refuse without isolation). Reviewers read the results through the `run_check` MCP bridge (Claude and Codex only) and cite hash evidence IDs; the findings gate checks them against each pass's validated `checks.json`. Decisions DR-261025-bridge-verify-review-run-check and DR-261025-run-verify-review-checks-where.

## What's Next

<!-- Track near-term follow-up work, known gaps, and active handoff context here.
Track concrete items in pjm/backlog/ and sequencing in pjm/roadmap.md; keep this
section to a short narrative pointer. -->
GitHub Actions workflows and publishers (p02), then AI PR review (p03); see `roadmap.md`. Known gaps: several CI routes are `qualified: null`; edit-mode retries reuse the workspace a failed attempt may have changed; Codex cannot reach `grok-4.7` through the proxy (Responses-only).

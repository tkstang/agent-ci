# OAT Current State

This file is the active operating picture and lives under `pjm/` (the
operational layer), not `reference/`. To reduce cross-worktree conflicts, keep
edits append-mostly and scoped to the section you own; avoid rewriting whole
sections another branch may also touch.

## Canonical References

<!-- List durable repo references, source-of-truth docs, dashboards, or processes here.
Decisions live in reference/decisions/ (one file per record); link them rather than
copying their content here. -->
- `docs/index.md` — the user documentation (getting started, routing, workflows, PR review, configuration, fleet repositories, security model); `pnpm docs:check` keeps its index and links valid.
- `models.yaml` — the routing table and its policy notes.
- `.github/workflows/` (reusable workflows) and `consumer-workflows/` (copy-in callers).
- `AGENTS.md` — toolchain, non-negotiables, definition of done.
- Decisions: `reference/decisions/index.md` (routing policy: DR-261025-route-models-through-a-checked; harness CLIs: DR-261025-run-agents-through-harness; tsrs: DR-261025-use-tsrs-instead-of-tsc; docs IA: DR-261025-organize-the-docs-as-one-flat).
- Active delivery: OAT project `agent-ci-v1` (brief mode, synced project files).

## What's Implemented

<!-- Summarize shipped capabilities and important repo conventions here. -->
As of 2026-10-25 (agent-ci-v1 phases p01-p06 on branch `feat/agent-ci-v1`, not merged; no release tag yet). The user-facing description of each capability is in `docs/`; this list is the operating summary.

- **CLI** `agent-ci` (one JSON envelope on stdout, `E_*` codes, logs on stderr): `run`, `route`, `models`, `doctor`, `validate`, plus the workflow-step commands `harness`, `skills`, `publish`, `review`, `preset`, `targets`, `tools-update`, `notify`, `workspace`, `digest`, `helpers`. New workflow-step logic becomes a `CommandSpec` in `src/commands/`.
- **Harness adapters** for `claude`, `codex`, `opencode`, `cursor` and a credential-free `fake` harness, each with a read-only and an edit posture; stdin closed, deadline with process-group kill, output cap, environment allowlist plus only the route's credentials, one isolated home root per run (login stores and executable harness config cleared each run; seeded logins local only).
- **Routing** (`models.yaml`, `src/routing/`): explicit model `family`; Claude only on the claude harness; no subscription-to-paid or work-account fallback (`--route` is the only way to a paid route); pool routes need the opt-in, run in CI only on a self-hosted runner, and Claude pool routes stay refused in CI (`CI_POOL_ALLOWS_CLAUDE = false`); login routes local only.
- **Run core**: prompt builder, supervisor with per-attempt workspace copies for edit retries, Zod result contracts (report, changes, issues, verdict), secret guard, `run-result.json`, `run-log.jsonl`, `changes.json`.
- **run-agent.yml** (p02): resolve, credential-free setup, agent (behind `agent-job.yml`, one route credential) and publish jobs; static-branch pull requests and PR comments without force pushes; optional webhook notification.
- **PR review** (p03): `pr-review.yml` and `agent-ci review` stages; label, comment or dispatch behind the write-access gate (forks never reach a credential); one or two reviewer passes, Claude-only tool-free adjudicator, deterministic findings gate, one inline review plus an updatable summary; `agent-ci review run` locally.
- **verify-review** (p04): checks from `.github/agent-ci/checks.yaml` on the default branch (or `verify_config_ref`) run in a secret-free verify job (GitHub-hosted unless `verify_on_self_hosted`); reviewers read results through the `run_check` MCP bridge (Claude and Codex only) and cite evidence IDs the gate recomputes. Every local `--verify` run needs `--verify-trust-pr-code`.
- **Wrappers and fan-out** (p05): `docs-update.yml`, `instructions-update.yml`, `tools-update.yml` with path policies; `fan-out.yml` over `targets.yaml` with scoped write and read target tokens; consumer and fleet templates.
- **Documentation** (p06): `docs/` (plain Markdown, one grouped index) and `pnpm docs:check` in CI; README is a short entry point.
- **Toolchain**: `tsrs` for typecheck and build (pinned pre-release), Oxc, Vitest, Zod 4, `yaml`.
- **Verified live (2026-10-25)**: one cheap run per harness locally; fake-harness Actions self-tests of `run-agent.yml`, `pr-review.yml` (including verify-review) and `fan-out.yml`; local model-backed review, verify-review and docs-update runs. Not yet live: a model-backed Actions run (no repository model secret), the default-branch review triggers, cross-repository targets, and a pool route on a self-hosted runner.

## What's Next

<!-- Track near-term follow-up work, known gaps, and active handoff context here.
Track concrete items in pjm/backlog/ and sequencing in pjm/roadmap.md; keep this
section to a short narrative pointer. -->
Finish agent-ci-v1: final review and the delivery pull request into `main` (not merged by the agent). After merge: qualify the CI routes once credentials exist (BL-261025-qualify-the-ci-routes-live), exercise the default-branch review triggers, and cut a release tag so consumer templates can pin it. Known gaps are listed in `docs/security-model.md` (residual risk) and the project journal's deferred findings, including Cursor account connector tools on headless runs (operator decision pending) and the pending decision on Claude pool routes in CI.

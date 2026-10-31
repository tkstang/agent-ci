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
- Delivery history: OAT project `agent-ci-v1` shipped and is complete and archived. No OAT project is active. The native [Review and fleet readiness delivery goal](backlog/reviews/review-and-fleet-readiness-goal.md) is active as of 2026-10-31.

## What's Implemented

Current baseline (2026-10-31): the public repository was recreated with root
`8ecf26a`; `main` at `95fec188` includes README PR #1 and publishing timeout
PR #2. Public-source cleanup is complete. Earlier PR numbers and commit pins
in the historical snapshot below belong to the previous repository history.

<!-- Summarize shipped capabilities and important repo conventions here. -->

As of 2026-10-30. agent-ci-v1 (phases p01-p06) merged as PR #25 on 2026-10-26; PR #28 (DeepSeek V4.1 Flash and GLM 5.3 Flash OpenCode routes) and PR #29 (`AGENT_CI_PROXY_BASE_URL` pool-origin override) merged after it. On 2026-10-30 `main` was squashed to one parentless commit (`369a99d`) ahead of making the repository public; pull-request metadata and old branches still reference the earlier history. No release tag yet. The user-facing description of each capability is in `docs/`; this list is the operating summary.

- **CLI** `agent-ci` (one JSON envelope on stdout, `E_*` codes, logs on stderr): `run`, `route`, `models`, `doctor`, `validate`, plus the workflow-step commands `harness`, `skills`, `publish`, `review`, `preset`, `targets`, `tools-update`, `notify`, `workspace`, `digest`, `helpers`. New workflow-step logic becomes a `CommandSpec` in `src/commands/`.
- **Harness adapters** for `claude`, `codex`, `opencode`, `cursor` and a credential-free `fake` harness, each with a read-only and an edit posture; stdin closed, deadline with process-group kill, output cap, environment allowlist plus only the route's credentials, one isolated home root per run (login stores and executable harness config cleared each run; seeded logins local only).
- **Routing** (`models.yaml`, `src/routing/`): explicit model `family`; cheap OpenCode Go routes (`deepseek-v4.1-flash-opencode`, `glm-5.3-flash-opencode`, `grok-4.7-opencode`) for fleets; an optional `AGENT_CI_PROXY_BASE_URL` secret replaces the loopback origin of every pool route (origin only, masked, passed only to pool-route agent and review steps); Claude only on the claude harness; no subscription-to-paid fallback or automatic fallback into account class `work` (`--route` is the only way to a paid route); pool routes need the opt-in, run in CI only on a self-hosted runner, and Claude pool routes stay refused in CI (`CI_POOL_ALLOWS_CLAUDE = false`); login routes local only.
- **Run core**: prompt builder, supervisor with per-attempt workspace copies for edit retries, Zod result contracts (report, changes, issues, verdict), secret guard, `run-result.json`, `run-log.jsonl`, `changes.json`.
- **run-agent.yml** (p02): resolve, credential-free setup, agent (behind `agent-job.yml`, one route credential) and publish jobs; static-branch pull requests and PR comments without force pushes; optional webhook notification.
- **PR review** (p03): `pr-review.yml` and `agent-ci review` stages; label, comment or dispatch behind the write-access gate (forks never reach a credential); one or two reviewer passes, Claude-only tool-free adjudicator, deterministic findings gate, one inline review plus an updatable summary; `agent-ci review run` locally.
- **verify-review** (p04): checks from `.github/agent-ci/checks.yaml` on the default branch (or `verify_config_ref`) run in a secret-free verify job (GitHub-hosted unless `verify_on_self_hosted`); reviewers read results through the `run_check` MCP bridge (Claude and Codex only) and cite evidence IDs the gate recomputes. Every local `--verify` run needs `--verify-trust-pr-code`.
- **Wrappers and fan-out** (p05): `docs-update.yml`, `instructions-update.yml`, `tools-update.yml` with path policies; `fan-out.yml` over `targets.yaml` with scoped write and read target tokens; consumer and fleet templates.
- **Documentation** (p06): `docs/` (plain Markdown, one grouped index) and `pnpm docs:check` in CI; README is a short entry point.
- **Toolchain**: `tsrs` for typecheck and build (pinned pre-release), Oxc, Vitest, Zod 4, `yaml`.
- **Verified live**: 2026-10-25, one cheap run per harness locally; fake-harness Actions self-tests of `run-agent.yml`, `pr-review.yml` (including verify-review) and `fan-out.yml`; local model-backed review, verify-review and docs-update runs. 2026-10-30, the private fleet (`tkstang/agent-ci-private-fleet`, pinned to `369a99d`) ran a model-backed `fan-out.yml` docs-update with `deepseek-v4.1-flash-opencode` on GitHub-hosted runners and merged its pull request, then a `fake-edit` run after the re-pin. Not yet live: the default-branch review triggers, cross-repository targets (no target tokens yet), and a pool route on a self-hosted runner (the runner VM awaits admission).

## What's Next

<!-- Track near-term follow-up work, known gaps, and active handoff context here.
Track concrete items in pjm/backlog/ and sequencing in pjm/roadmap.md; keep this
section to a short narrative pointer. -->

The operator activated [Review and fleet readiness](backlog/reviews/review-and-fleet-readiness-goal.md): production reviewer configuration first, then **BL-261025-self-hosted-runner-and-proxy — Self-hosted runner and proxy readiness**, **BL-261025-close-remaining-claude-only — Close remaining Claude-only policy name-check gaps**, **BL-261025-post-v1-simplification-pass — Post-v1 simplification pass**, and **BL-261025-fleet-repositories-merged — Fleet repositories: merged target lists and protected artifacts**. The selected defaults and revised Claude-pool policy are recorded in [Production reviews and pool CI](../reference/decisions/DR-261031-production-reviews-and-pool-ci.md); implementation is pending review/merge and new routes are not live-qualified. Sol adjudication still needs an approved, verified tool-free transport.

The private fleet's old agent-ci pin is unavailable after recreation and it
still maps the retired source token. Caller migration requires separate
authorization; deleting `AGENT_CI_SOURCE_TOKEN` still requires a fresh no-reader
check and explicit approval. The runner project's current fixed allowlist
does not admit the private fleet, so its existing pilot alone will not supply
an agent-ci runner. Target-token provisioning and privileged host admission
remain user-owned. Publisher-token support and native Codex persistent login
remain Next, outside this delivery goal.

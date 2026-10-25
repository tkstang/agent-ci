# OAT Backlog Completed

> Summary archive for completed backlog work. Keep newest entries first. Use `backlog/archived/` for full file-per-item historical records when a completed item still needs rich context.

## Entry Format

- `YYYY-MM-DD — BL-YYMMDD-slug — Title — one-line outcome summary`

## Completed Items

- 2026-10-25 — BL-261025-use-case-wrappers-and-multi — Use-case wrappers and multi-repo fan-out — Done in agent-ci-v1 p05 (accepted): docs-update, instructions-update and tools-update wrappers with path policies, targets.yaml with agent-ci targets validate/matrix/resolve, fan-out.yml with scoped target tokens, fleet template and a live fake-harness fan-out run; documented in docs/workflows.md and docs/fleet-repo.md.
- 2026-10-25 — BL-261025-verify-review-run-check-tool — Verify-review run_check tool bridge — Done in agent-ci-v1 p04 (accepted): verify-review with checks.yaml from the default branch (or verify_config_ref), a secret-free verify job, controlled per-check execution with evidence IDs, the run_check MCP bridge for Claude and Codex, and --verify-trust-pr-code for every local run; documented in docs/pr-review.md and docs/security-model.md.
- 2026-10-25 — BL-261025-ai-pull-request-review — AI pull-request review workflow — Done in agent-ci-v1 p03 (accepted): pr-review.yml and agent-ci review stages with the permission gate (forks never reach a credential), schema or prompt-and-parse reviewer passes with one repair turn, Claude-only tool-free adjudicator, deterministic findings gate and one inline review plus summary; live local review and fake-harness Actions self-test; documented in docs/pr-review.md.
- 2026-10-25 — BL-261025-reusable-run-agent-workflow — Reusable run-agent workflow and publishers — Done in agent-ci-v1 p02 (accepted): run-agent.yml with resolve, credential-free setup, agent (agent-job.yml boundary, one route credential) and publish jobs; static-branch PR and comment publishers; per-attempt workspace isolation for edit retries; consumer template; fake-harness Actions self-tests; documented in docs/workflows.md.
- 2026-10-25 — BL-261025-guard-login-tokens-refreshed — Guard login tokens refreshed during a run — Done in agent-ci-v1 p01-t17 (phase gate H1): runAgent re-reads token values from the isolated login stores after every attempt (OpenCode via opencode auth export --standalone on the isolated home), keeps seed and refreshed values, and the run log re-checks earlier records against the expanded set; regression tests cover a mid-run rotation echoed in the answer and an earlier log record.
- 2026-10-25 — BL-261025-live-verify-opencode-read-only — Live-verify OpenCode read-only deny rules — Verified live on opencode v2.0.27 (2026-10-25): read-only deny rules remove the write and shell tools (control without rules wrote a file and ran touch); adapter now denies edit, bash, shell, webfetch and websearch. agent-ci-v1 p01-t13.

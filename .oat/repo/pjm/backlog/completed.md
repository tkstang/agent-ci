# OAT Backlog Completed

> Summary archive for completed backlog work. Keep newest entries first. Use `backlog/archived/` for full file-per-item historical records when a completed item still needs rich context.

## Entry Format

- `YYYY-MM-DD — BL-YYMMDD-slug — Title — one-line outcome summary`

## Completed Items

- 2026-10-25 — BL-261025-guard-login-tokens-refreshed — Guard login tokens refreshed during a run — Done in agent-ci-v1 p01-t17 (phase gate H1): runAgent re-reads token values from the isolated login stores after every attempt (OpenCode via opencode auth export --standalone on the isolated home), keeps seed and refreshed values, and the run log re-checks earlier records against the expanded set; regression tests cover a mid-run rotation echoed in the answer and an earlier log record.
- 2026-10-25 — BL-261025-live-verify-opencode-read-only — Live-verify OpenCode read-only deny rules — Verified live on opencode v2.0.27 (2026-10-25): read-only deny rules remove the write and shell tools (control without rules wrote a file and ran touch); adapter now denies edit, bash, shell, webfetch and websearch. agent-ci-v1 p01-t13.

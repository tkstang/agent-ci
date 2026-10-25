# Roadmap

This file records prioritized direction and lives under `pjm/` (the operational
layer). To reduce cross-worktree conflicts, prefer adding or moving single
bullet lines over rewriting whole sections, and reference backlog records by ID
(`BL-YYMMDD-slug`) rather than restating their detail here.

## Now (Active / Committed)

<!-- Add active work here. Format:
- **BL-YYMMDD-slug: {title}** — brief description. Project: {name} (if linked)
-->
- **BL-261025-reusable-run-agent-workflow: Reusable run-agent workflow and publishers** — `run-agent.yml`, publish job, consumer template. Project: agent-ci-v1 (p02)
- **BL-261025-ai-pull-request-review: AI pull-request review workflow** — the flagship workflow. Project: agent-ci-v1 (p03)

## Next (Planned)

<!-- Add planned work here. Format:
- **BL-YYMMDD-slug: {title}** — brief description. Project: {name} (if linked)
-->
- **BL-261025-verify-review-run-check-tool: Verify-review run_check tool bridge** — controlled repository checks for the reviewer. Project: agent-ci-v1 (p04)
- **BL-261025-use-case-wrappers-and-multi: Use-case wrappers and multi-repo fan-out** — docs, instructions and tools updates; `targets.yaml`. Project: agent-ci-v1 (p05)
- **BL-261025-documentation-tree-and-docs: Documentation tree and docs check** — `docs/` and `pnpm docs:check`. Project: agent-ci-v1 (p06)
- **BL-261025-live-verify-opencode-read-only: Live-verify OpenCode read-only deny rules** — prove edits and shell are denied.
- **BL-261025-qualify-the-ci-routes-live: Qualify the CI routes live** — routes still marked `qualified: null`.

## Later (Directional Intent)

<!-- Add directional work here. Format:
- **BL-YYMMDD-slug: {title}** — brief description. Project: {name} (if linked)
-->
- Personal self-hosted runner integration (`tkstang/actions-runner`), pending its credential-admission decision. Out of scope for agent-ci-v1.
- Public repository or published package for helper distribution, replacing `AGENT_CI_SOURCE_TOKEN`.
- Promotion to a work repository (re-confirm pntr-derived code ownership first; see DR-261025-port-pntr-code-where-it-fits).

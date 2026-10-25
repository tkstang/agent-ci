# Roadmap

This file records prioritized direction and lives under `pjm/` (the operational
layer). To reduce cross-worktree conflicts, prefer adding or moving single
bullet lines over rewriting whole sections, and reference backlog records by ID
(`BL-YYMMDD-slug`) rather than restating their detail here.

## Now (Active / Committed)

<!-- Add active work here. Format:
- **BL-YYMMDD-slug: {title}** — brief description. Project: {name} (if linked)
-->
- **BL-261025-documentation-tree-and-docs: Documentation tree and docs check** — `docs/` and `pnpm docs:check`, then the agent-ci-v1 delivery pull request. Project: agent-ci-v1 (p06)

## Next (Planned)

<!-- Add planned work here. Format:
- **BL-YYMMDD-slug: {title}** — brief description. Project: {name} (if linked)
-->
- **BL-261025-qualify-the-ci-routes-live: Qualify the CI routes live** — `claude-haiku-4-5-personal` and `grok-4.7-opencode` still `qualified: null`; needs the operator's credentials.
- **BL-261025-close-remaining-claude-only: Close remaining Claude-only policy name-check gaps** — before adding a Cursor `auto` or separator-less Claude-like route.
- Release tag for consumer pins — the templates show `@v0.1.0`/`@main`, and no tag exists yet.

Shipped on `feat/agent-ci-v1` (archived backlog items): BL-261025-reusable-run-agent-workflow (p02), BL-261025-ai-pull-request-review (p03), BL-261025-verify-review-run-check-tool (p04), BL-261025-use-case-wrappers-and-multi (p05).

## Later (Directional Intent)

<!-- Add directional work here. Format:
- **BL-YYMMDD-slug: {title}** — brief description. Project: {name} (if linked)
-->
- Personal self-hosted runner integration (`tkstang/actions-runner`), pending its credential-admission decision. Out of scope for agent-ci-v1.
- Public repository or published package for helper distribution, replacing `AGENT_CI_SOURCE_TOKEN`.
- Promotion to a work repository (re-confirm pntr-derived code ownership first; see DR-261025-port-pntr-code-where-it-fits).

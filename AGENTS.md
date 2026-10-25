# AGENTS.md

Single-package TypeScript library + agent-first CLI. ESM-only, Node 24, pnpm 11,
extra-strict TypeScript, Oxc (oxlint + oxfmt), Vitest, Zod at boundaries. The
domain layer returns a result-envelope (`Success | Failure` with closed `E_*`
codes); boundaries throw a typed `CliError` caught by one central handler.

## Headline defaults

Oxc toolchain - TypeScript 7 / ESM-only / Node 24 / pnpm 11.x (double-pinned) -
Vitest 4 with co-located `*.test.ts` siblings (globals off) - Zod 4 at
boundaries - Conventional Commits - custom git hooks in `tools/git-hooks/` (no
husky/lefthook) - `private: true` + MIT LICENSE.

## Non-Negotiables

- **Machine-readable error codes, never string matching** on messages.
- **Conventional Commits** on every commit, every branch.
- **Import policy:** only same-directory relative (`./...`). For anything outside
  the current dir use the named `@agent-ci/*` tsconfig alias (mirrored in
  `vitest.config.ts`). Never `../..` chains, never a catch-all `@/*`.
- **Never commit secrets** (`.mcp.json` is gitignored) or build output (`dist/`).
- **Lean dependencies** - stdlib + native `fetch` first; a dep must earn its place.
- **Agent-first CLI:** one JSON envelope on stdout, logs to stderr, `E_*` exit
  codes, no interactivity, NO_COLOR-safe.

## Definition of Done

Run the narrowest sufficient checks - do not over-gate:

- typecheck (`pnpm run typecheck`)
- lint (`pnpm run lint`)
- focused test (the suite touching the change)
- format (`pnpm run format:check`) before a commit/PR is ready
- build only when wiring changes (entrypoints, exports, path aliases)

There is never a CI coverage gate.

## Agent setup

This scaffold deliberately ships only a MINIMAL agent layer (this `AGENTS.md`
and a starter `.claude/settings.json`; there is no `CLAUDE.md`, because Claude
Code reads `AGENTS.md` directly; `pnpm run check:agents` in pre-commit and CI fails if
any `CLAUDE.md` exists). It does
**not** pre-bake `.agents/`, provider mirrors (`.cursor/`, `.codex/`), or `.oat/`.

Run **`oat init`** with the latest OAT installed for the full guided agent/OAT
setup (canonical `.agents/`, provider sync, project lifecycle). Do not
hand-assemble the OAT layer.

## Worktrees

- After `git worktree add`, run `pnpm run worktree:init` in the new worktree to
  copy local-only files, install dependencies, configure hooks, and refresh OAT
  local/provider state when present.
- Run `pnpm run worktree:validate` before handoff or push. It asserts a clean
  tree, runs the local gate, and asserts cleanliness again to catch generated
  drift.

<!-- OAT tools -->
## Tool Packs

- **User skills directory:** `~/.agents/skills/` (core, ideas, docs, workflows, utility, project-management, research, brainstorm packs installed at user scope)
- **Discover available skills:** scan `~/.agents/skills/*/SKILL.md`
- **Refresh provider views:** `oat sync --scope all`
- **Update skills to latest versions:** `oat tools update`

### Installed Packs

- **core** — Diagnostics and documentation (oat-doctor, oat-docs) _(user scope)_
- **ideas** — Idea capture and refinement _(user scope)_
- **docs** — Documentation and instruction governance workflows _(user scope)_
- **workflows** — Project lifecycle (create, discover, plan, implement, review, complete) _(user scope)_
- **utility** — Standalone utilities (skill authoring, maintainability review, code reviews) _(user scope)_
- **project-management** — Local backlog, roadmap, and reference doc management (oat-pjm-* skills) _(user scope)_
- **research** — Research, analysis, verification, and synthesis _(user scope)_
- **brainstorm** — Always-on brainstorming entry point with visual companion _(user scope)_

### Workflow Execution Continuation

- This guidance applies only to OAT project lifecycle execution, such as `oat-project-implement`, and OAT project review/receive flows. It does not apply to non-OAT tasks or ad-hoc work outside the OAT project workflow.
- When executing an OAT project implementation or OAT project review workflow, do not stop at task boundaries, phase boundaries, or other clean checkpoints unless the configured HiLL checkpoint has been reached, a real blocker exists, or explicit user input is required.
- Status summaries, completed bookkeeping, and "clean boundary" pauses are not valid stop reasons. After updating tracking artifacts, continue execution until an allowed stop condition applies.
<!-- END OAT tools -->

# AGENTS.md

Single-package TypeScript library + agent-first CLI. ESM-only, Node 24, pnpm 11,
extra-strict TypeScript checked and emitted by `tsrs`, Oxc (oxlint + oxfmt),
Vitest, Zod at boundaries. The
domain layer returns a result-envelope (`Success | Failure` with closed `E_*`
codes); boundaries throw a typed `CliError` caught by one central handler.

## Headline defaults

Oxc toolchain - `tsrs` (oxc-project's Rust port of the TypeScript 7 compiler,
exact-pinned pre-release; replaces `tsc` for `typecheck` and `build`, with
`tsc-alias` kept for alias rewriting; TypeScript 7 `tsc` stays installed as the
fallback) / ESM-only / Node 24 / pnpm 11.x (double-pinned) -
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
- docs (`pnpm run docs:check`) when `docs/`, `README.md` or `AGENTS.md` change
- `pnpm run check:agents` (no `CLAUDE.md` anywhere); pre-commit and CI run it
- `actionlint` when workflows, the setup action or `consumer-workflows/` change
  (CI runs it from the pinned `rhysd/actionlint` image); workflow structure
  tests live in `src/workflows/`

There is never a CI coverage gate.

## Agent setup

The agent layer is this `AGENTS.md` and a starter `.claude/settings.json`.
There is no `CLAUDE.md`, because Claude Code reads `AGENTS.md` directly;
`pnpm run check:agents` in pre-commit and CI fails if any `CLAUDE.md` exists.
There is no `.agents/` directory and no provider mirror (`.cursor/`,
`.codex/`).

OAT is initialized: `.oat/` holds project-management state and decision
records (start at `.oat/repo/AGENTS.md`). Do not hand-assemble the OAT layer.

The OAT tool packs and skills named in the sections below are optional
maintainer tooling, installed at user scope on the maintainer's machines.
Contributors do not need them; the `pnpm` checks above are the required
gate.

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

<!-- OAT project-management -->
### Project Management

- Installed project-management tools provide capability; they do not prove that this repository adopted PJM.
- Run `oat pjm doctor --json` and inspect `adoption.state` before any PJM write.
- Repository planning and durable context live under `.oat/repo/`.
- Consult it when prioritizing or planning work, checking the backlog, starting or closing tracked work, or looking for established repository context.
- Start with `.oat/repo/AGENTS.md`; it routes to `pjm/` for active state and `reference/` for durable records.
- If adoption is absent or partial, stop and initialize it with `oat pjm init`.
<!-- END OAT project-management -->

<!-- OAT decisions -->
### Decision Records

- Durable repository decisions live under `.oat/repo/reference/decisions/`; read `.oat/repo/reference/decisions/AGENTS.md` before working with them.
- Before finalizing a durable repository decision, review `.oat/repo/reference/decisions/index.md` and any relevant records.
- When the user asks to record a durable decision or confirms a proposed capture, use `oat-pjm-decision` when that skill is installed; otherwise use `oat decision new`.
- Do not hand-edit the generated decision index; run `oat decision regenerate-index` after record changes or to resolve index conflicts.
- Run `oat pjm doctor --json` and inspect `adoption.state` before any decision write.
- If the decision surface is missing, repository adoption is absent or partial; stop and initialize it with `oat pjm init`.
<!-- END OAT decisions -->

<!-- OAT docs -->
## Documentation

- **Docs root:** `docs`
- **Tooling:** Markdown
- **Authored index:** `docs/index.md`
- **Contributing:** `docs/contributing.md`

Keep authored context, title/description metadata, and Contents maps with relative Markdown links current. Preserve local instructions; asset-only directories are exempt from indexes.
Use `oat-docs-analyze` to audit gaps and `oat-docs-apply` for approved repairs. Optional generated inventories belong outside the content tree and do not replace the authored index.
<!-- END OAT docs -->

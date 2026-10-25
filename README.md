# @tkstang/agent-ci — single-package TypeScript library + CLI starter

A minimal, opinionated starting point for a **single-package** TypeScript project
that ships both a **library** (importable barrel) and an **agent-first CLI**. It
embodies the house "bleeding-edge" profile from the `foundations` conventions.

> [!IMPORTANT]
> **Versions were revalidated in August 2026 — revalidate before relying on
> them.** Tooling here uses stable TypeScript 7 with fast-moving Oxc and pnpm 11.
> Re-check each pin before adopting, especially the pre-1.0 `oxfmt`.

## Stack

| Concern           | Choice                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Language          | TypeScript 7 (extra-strict superset), ESM-only                                                                     |
| Module/resolution | `NodeNext` / `NodeNext`, target `ES2024`                                                                           |
| Runtime           | Node 24 (`.nvmrc`, `engines.node >=24`)                                                                            |
| Package manager   | pnpm 11.x (double-pinned: `packageManager` + `engines.pnpm`)                                                       |
| Lint / format     | Oxc — `oxlint` + `oxfmt` (`arrowParens: always`)                                                                   |
| Tests             | Vitest 4, globals OFF, **co-located `*.test.ts` siblings**                                                         |
| Validation        | Zod 4 at boundaries                                                                                                |
| Errors            | Result-envelope (`Success \| Failure`, closed `E_*` codes) in domain code; typed `CliError` thrown at the boundary |
| Build             | `tsc` + `tsc-alias` → `dist/`                                                                                      |
| Dev runner        | `tsx`                                                                                                              |
| Commits           | Conventional Commits via commitlint                                                                                |
| Git hooks         | custom `tools/git-hooks/` (no husky/lefthook), wired by `prepare`                                                  |
| CI                | GitHub Actions: lint → format:check → typecheck → test → build                                                     |
| License           | `private: true` + committed MIT `LICENSE`                                                                          |

## What's inside

```
src/
  index.ts        library barrel (parseConfig + Result + CliError)
  config.ts       parseConfig(): Result<Config> via a zod schema (boundary)
  result.ts       Success | Failure envelope, closed E_* error-code tuple
  errors.ts       CliError (typed boundary error) + isCliError guard
  cli.ts          agent-first CLI: one JSON envelope on stdout, E_* exit codes
  *.test.ts       co-located Vitest suites
```

## Getting started

1. **Rename the placeholder scope.** This scaffold uses `@agent-ci/*` for both the
   package name and the path alias. Replace `@app` with `@<project>` across:
   - `package.json` `name`
   - `tsconfig.json` `paths` (`@agent-ci/*`)
   - `vitest.config.ts` `resolve.alias`
   - `src/**` import specifiers
   - this README

2. **Install** (uses the pinned pnpm via Corepack):

   ```sh
   pnpm install
   ```

3. **Run the checks** (the Definition of Done):

   ```sh
   pnpm run typecheck
   pnpm run lint
   pnpm run format:check
   pnpm run test
   pnpm run build
   ```

4. **Try the CLI** (after `pnpm run build`, or via `pnpm run dev`):

   ```sh
   node dist/cli.js --config '{"name":"my-app"}'
   # {"ok":true,"command":"parse-config","data":{"name":"my-app","retries":3,"verbose":false}}

   echo '{"name":"x"}' | node dist/cli.js --stdin
   ```

5. **Set up the agent/OAT layer.** This scaffold ships only a minimal agent layer
   (`AGENTS.md` + a starter `.claude/settings.json`; no `CLAUDE.md`, since
   Claude Code reads `AGENTS.md` directly; `pnpm run check:agents` in pre-commit and CI
   fails if any `CLAUDE.md` or `CLAUDE.local.md` exists, including gitignored ones).
   With the latest OAT installed, run:

   ```sh
   oat init
   ```

   It owns the guided per-project setup (canonical `.agents/`, provider sync,
   project lifecycle). The scaffold deliberately does **not** pre-bake `.agents/`,
   provider mirrors, or `.oat/`.

## Scripts

| Script                       | Does                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| `pnpm run dev`               | `tsx watch src/cli.ts`                                       |
| `pnpm run build`             | emit to `dist/` via `tsc` + `tsc-alias`                      |
| `pnpm run typecheck`         | `tsc --noEmit`                                               |
| `pnpm run lint`              | `oxlint`                                                     |
| `pnpm run format`            | `oxfmt --write .` (rewrite)                                  |
| `pnpm run format:check`      | `oxfmt --check .`                                            |
| `pnpm run test`              | `vitest run`                                                 |
| `pnpm run prepare`           | wire this repo's Git hooks through `tools/install-hooks.mjs` |
| `pnpm run worktree:init`     | bootstrap a new git worktree with local-only state           |
| `pnpm run worktree:validate` | clean-tree local validation gate before handoff              |

After `git worktree add`, run `pnpm run worktree:init` inside the new worktree.
Run `pnpm run worktree:validate` before handoff or push. If the repo has run
`oat init`, init also syncs OAT local paths, provider views, and archived project
docs from S3 where configured.

## NOTES / Deviations

- **TypeScript 7 is primary.** `typescript-7@npm:typescript` supplies the stable
  `tsc` binary for typecheck and emit. `typescript@npm:@typescript/typescript6`
  remains beside it for compiler-API ecosystem compatibility and exposes `tsc6`;
  use that binary only for differential diagnosis or a demonstrated TS7 blocker.
  A truly minimal repo with no compiler-API consumers may simplify to pure
  `typescript@^7`.
- **Module resolution is `NodeNext`** (not the conventions' usual
  `ESNext`/`bundler`). This is the deliberate bleeding-edge choice for this
  scaffold: native Node ESM semantics, no bundler. `tsc-alias` still rewrites the
  `@agent-ci/*` path alias and appends runtime `.js` extensions at build.
- **`@types/node` is pinned to `^24`** to match the Node 24 runtime target even
  though `@types/node@26` exists.
- No `.editorconfig` (dropped by house decision; oxfmt is the single formatter).

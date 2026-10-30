---
id: DR-261025-use-tsrs-instead-of-tsc
title: Use tsrs instead of tsc for type checking and emit
date: 2026-10-25
status: accepted
legacy_id: null
---

# Use tsrs instead of tsc for type checking and emit

## Context

foundations specifies TypeScript 7 `tsc` (+ `tsc-alias`) for typecheck and build. The operator asked to use `tsrs`, oxc-project's Rust port of the TypeScript 7 compiler. Probe 2026-10-25: `tsrs@0.18.0-ts7.1.0-dev.20260929` type-checks and emits the scaffold, and exits 2 on a type error for both `pnpm typecheck` and `pnpm build`.

## Decision

`typecheck` runs `tsrs --noEmit -p tsconfig.json` and `build` runs `tsrs -p tsconfig.build.json && tsc-alias -p tsconfig.build.json`, with tsrs pinned to the exact pre-release version. This deviates from foundations.

## Consequences

tsrs is a pre-release; bump deliberately and re-run the failing control. TypeScript 7 `tsc` stays installed as the fallback if a tsrs defect blocks work (record the switch). The TS6 API package stays because commitlint's config loader needs it.

---
id: DR-261025-workflow-steps-call-agent-ci
title: Workflow steps call agent-ci subcommands
date: 2026-10-25
status: accepted
legacy_id: null
---

# Workflow steps call agent-ci subcommands

## Context

Long inline shell in workflow steps is hard to read and untested.

## Decision

Workflow YAML stays thin: any step logic longer than about 12 lines is TypeScript under `src/` exposed as an `agent-ci` subcommand (one `CommandSpec` module registered in `src/commands/registry.ts`).

## Consequences

Workflows build agent-ci once per job and call one command per step. Rejected: `node file.ts` type stripping (breaks on the `@agent-ci/*` alias, scatters untested scripts) and per-step `github-script` bundling as the main mechanism.

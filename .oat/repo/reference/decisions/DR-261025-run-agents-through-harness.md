---
id: DR-261025-run-agents-through-harness
title: Run agents through harness CLIs, not SDKs or the AI SDK
date: 2026-10-25
status: accepted
legacy_id: null
---

# Run agents through harness CLIs, not SDKs or the AI SDK

## Context

The earlier prototype's generic runner needs only: run an agent in a directory with a prompt and return its final text. agent-ci must drive Claude Code, Codex, OpenCode and Cursor (research 2026-10-24, project agent-ci-v1).

## Decision

Each harness is driven through its own CLI (`claude -p`, `codex exec`, `opencode run`, Cursor `agent -p`) behind one `HarnessAdapter` interface in `src/harness/`. The Vercel AI SDK core loop and its experimental `HarnessAgent` are not used.

## Consequences

Harness CLIs keep their native skills, tools and AGENTS.md discovery. agent-ci owns argv, environment, isolation and output parsing per harness, and must re-verify flags when a CLI version changes. Rejected: rebuilding a coding agent on the AI SDK loop, and `HarnessAgent` (experimental, needs a network sandbox, broken Claude Code adapter package as of 2026-10-24).

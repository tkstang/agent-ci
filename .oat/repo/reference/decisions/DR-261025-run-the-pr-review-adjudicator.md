---
id: DR-261025-run-the-pr-review-adjudicator
title: Run the PR-review adjudicator only on Claude with every tool removed
date: 2026-10-25
status: accepted
legacy_id: null
---

# Run the PR-review adjudicator only on Claude with every tool removed

## Context

The adjudicator reads untrusted pull-request text (reviewer findings and cited source) while holding a model credential, so it must have no tools: no file reads, shell, network or MCP. pntr enforced this with a Cursor SDK hook. agent-ci drives harness CLIs, and the brief deferred the per-harness lockdown to p03 (Known Unknowns). Live probe 2026-10-25 (references/research/review-harness-probes-2026-10-25.md): claude -p --tools "" with --strict-mcp-config, --setting-sources user and --permission-mode dontAsk offered only its internal StructuredOutput tool and could not read /etc/hosts or list files, while the read-only control listed the workspace. Codex has no tool-free mode (-s read-only still offers a read-only shell), OpenCode's deny rules were not verified for an all-tools denial with a structured answer, and Cursor's ask mode still runs classifier-approved shell commands.

## Decision

The adjudicator runs only on harnesses with a verified tool-free posture: Claude (and the credential-free fake harness used by tests and the self-test). The run core refuses a tool-free run on any other harness before anything starts (E_POLICY_HARNESS), the gate refuses an adjudicator model whose route is not on such a harness, and adapters declare the capability (supportsNoTools). The adjudicator gets its candidates and line-numbered source windows in the prompt (sources fetched from the git database API (trees and blobs) in a step without the model credential), runs in an empty scratch directory outside any checkout with --json-schema, and its answer is validated after the run with one repair turn by session resume; the findings gate re-enforces every limit.

## Consequences

An adjudicator needs a Claude route (CLAUDE_CODE_OAUTH_TOKEN or an API key in CI); grok, GLM, GPT and Cursor models can review but cannot adjudicate. Re-run the probe when the pinned Claude Code version changes. The prompt carries at most 40 KiB of candidates and 40 KiB of source windows so it fits one argv entry; larger reviews mark candidates past the budget as keep-only.

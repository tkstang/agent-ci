---
id: DR-261025-build-ai-pull-request-review
title: Build AI pull-request review before the use-case wrappers
date: 2026-10-25
status: accepted
legacy_id: null
---

# Build AI pull-request review before the use-case wrappers

## Context

PR review is the operator's highest-value personal workflow.

## Decision

PR review (p03) lands before docs/instructions/tools wrappers (p05). Its first version is schema-first and needs no MCP server; the verify-review `run_check` tool bridge comes later (p04).

## Consequences

Schema-final output drops the prototype's in-run reject-and-resubmit loop: agent-ci validates after the run and allows one bounded repair turn by resuming the same session; findings still invalid are dropped by the deterministic gate and reported. The adjudicator runs only on harnesses with a verified tool lockdown.

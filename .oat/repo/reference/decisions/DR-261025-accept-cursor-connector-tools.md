---
id: DR-261025-accept-cursor-connector-tools
title: Accept Cursor connector tools on headless runs
date: 2026-10-25
status: accepted
legacy_id: null
---

# Accept Cursor connector tools on headless runs

## Context

A p04 bridge probe on 2026-10-25 showed that headless Cursor agent -p runs on the work account are offered the account's cloud connector tools (mail- and calendar-style actions such as create_draft, trash_thread and create_event), whatever the isolated agent-ci home contains. This affects every Cursor run and review route, not only verify-review, where Cursor is refused. It was recorded as a deferred finding for an operator decision.

## Decision

The operator accepted the risk on 2026-10-25 (agent-ci-v1). Cursor routes stay available for runs and reviews on private-repository pull requests. The operator does not run Cursor routes for untrusted outsiders on public repositories; agent-ci does not enforce this, and the write-access gate is the only control. No code change was made.

## Consequences

docs/security-model.md keeps listing the connector exposure as residual risk and advises against running Cursor on untrusted content. Before any Cursor route runs on untrusted pull-request content or a public repository, check whether the account can disable connectors for API keys, and revisit this decision.

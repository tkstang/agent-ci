---
id: BL-261025-ai-pull-request-review
title: AI pull-request review workflow
status: open
priority: high
scope: feature
scope_estimate: XL
labels:
  - review
  - workflows
assignee: null
created: 2026-10-25T05:50:35.678Z
updated: 2026-10-25T05:50:35.678Z
associated_issues: []
external_plans: []
---

## Description

Project agent-ci-v1 phase p03. Trigger by label, comment or dispatch behind a permission gate; one or two reviewer passes with schema-constrained output where the harness supports it; a deterministic findings gate (re-read cited source, quote hashes, diff positions); optional adjudicator on harnesses with a verified tool lockdown; one published PR review plus an updatable summary comment. Fork PRs never receive model credentials. Ported from pntr PR review (voxmedia/pntr@e438668).

## Acceptance Criteria

- Trigger by label, comment or dispatch behind a permission gate (requester has write/admin; fork PRs never get model credentials or run the agent)
- Unit tests pass for the permission gate, the deterministic findings gate (re-read cited source, quote hashes, diff positions), rendering and publishing
- A live review of a test PR in `tkstang/agent-ci` with a cheap model publishes one PR review with inline comments plus an updatable summary comment, recorded in the journal

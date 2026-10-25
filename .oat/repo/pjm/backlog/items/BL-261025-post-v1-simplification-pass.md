---
id: BL-261025-post-v1-simplification-pass
title: Post-v1 simplification pass
status: open
priority: medium
scope: feature
scope_estimate: L
labels:
  - complexity
  - workflows
  - review
assignee: null
created: 2026-10-25T22:58:43.258Z
updated: 2026-10-25T22:58:43.258Z
associated_issues: []
external_plans: []
---

## Description

From the PR #25 complexity review (all non-blocking). Decide and apply: (1) shrink verify-review local isolation now that --verify-trust-pr-code is mandatory — keep env allowlist, PATH control, fresh copy, process-group kill, output bound; drop harness pinning, root-owned tool resolution, broker-socket hiding, remounts and the sandbox-exec profile (src/review/verify.ts, src/harness/pin.ts, src/review/local.ts), and check the trust flag at CLI entry; (2) extract review passes into a review-pass.yml workflow_call boundary (dedupes review-primary/review-second and closes the deferred 'reviewer runners hold every model secret' residual); (3) remove reusable-workflow inputs no caller uses before v1 has consumers; (4) dedupe tools-update/run-agent resolve+publish jobs and the docs-update/instructions-update wrappers; (5) single rule implementations (adjudication rules, protected severity, command detection; one runSafeGit; checkPullDiff as the single publish authority; split runInHome in src/run/execute.ts); (6) pin the git dir for change detection and HEAD reads after in-place (non-copy) edit runs (src/run/execute.ts ~922-934). Check GitHub's reusable-workflow nesting limit before (2)/(4).

## Acceptance Criteria

- Each of the six areas is either simplified (with tests protecting the kept guarantees still green) or explicitly declined with a reason recorded here
- In-place edit runs read changes and HEAD through a git dir pinned before the agent runs, with a regression test redirecting `core.worktree`
- Removed workflow inputs are listed in the release notes


---
id: BL-261025-post-v1-simplification-pass
title: Post-v1 simplification pass
status: closed
priority: medium
scope: feature
scope_estimate: L
labels:
  - complexity
  - workflows
  - review
assignee: null
created: 2026-10-25T22:58:43.258Z
updated: '2026-10-31T20:49:03Z'
associated_issues: []
external_plans: []
---

## Description

From the PR #25 complexity review (all non-blocking). Decide and apply: (1) shrink verify-review local isolation now that --verify-trust-pr-code is mandatory — keep env allowlist, PATH control, fresh copy, process-group kill, output bound; drop harness pinning, root-owned tool resolution, broker-socket hiding, remounts and the sandbox-exec profile (src/review/verify.ts, src/harness/pin.ts, src/review/local.ts), and check the trust flag at CLI entry; (2) extract review passes into a review-pass.yml workflow_call boundary (dedupes review-primary/review-second and closes the deferred 'reviewer runners hold every model secret' residual); (3) remove reusable-workflow inputs no caller uses before v1 has consumers; (4) dedupe tools-update/run-agent resolve+publish jobs and the docs-update/instructions-update wrappers; (5) single rule implementations (adjudication rules, protected severity, command detection; one runSafeGit; checkPullDiff as the single publish authority; split runInHome in src/run/execute.ts); (6) pin the git dir for change detection and HEAD reads after in-place (non-copy) edit runs (src/run/execute.ts ~922-934). Check GitHub's reusable-workflow nesting limit before (2)/(4).

## Acceptance Criteria

- Each of the six areas is either simplified (with tests protecting the kept guarantees still green) or explicitly declined with a reason recorded here
- In-place edit runs read changes and HEAD through a git dir pinned before the agent runs, with a regression test redirecting `core.worktree`
- Removed workflow inputs are listed in the release notes

## Assessment and delivery (2026-10-31)

1. **Retain verification hygiene; fail fast at CLI entry.** Mandatory trust
   acknowledges host credential reachability; it does not make subprocess
   cleanup, restricted writes/network, pin verification or credential-store
   hiding redundant. `src/review/verify.ts` records actual isolation and its
   tests cover secret scrubbing, controlled PATH, root-owned tool resolution,
   root refusal, process lifetime and host-specific isolation. Local review
   pins harness and bridge files before checks and verifies them again before
   model execution (`src/review/local.ts`). Removing these protections adds
   exposure without simplifying the separate credential-free Actions boundary.
   Retain them. `review run --verify` now refuses missing trust at CLI entry,
   before GitHub requests, output preparation or worktree changes; the existing
   CLI regression proves those side effects are absent.
2. **Extract reviewer and adjudicator job boundaries.** `review-pass.yml`
   deduplicates primary/second bodies; `review-adjudicate.yml` preserves the
   different scratch/source-fetch path. Each child receives one statically
   selected model credential and pool origin only for a pool route. Gate
   route outputs contain names, never credentials. Existing pass artifact IDs,
   digests, optional stages and fail-closed loaders remain. Sol adjudication
   is still refused pending the separate tool-free transport choice.
3. **Retain public workflow inputs; none removed.** A parsed workflow sweep
   found every declared input referenced by its implementation (29 run-agent,
   26 review, 13 fan-out, 15 tools, 18 each maintenance wrapper before any
   later fleet additions). This is not proof every consumer uses each input.
   The interfaces are public and documented: helper overrides support pinned
   sources/forks, identity settings support App publishers, timeouts/bounds
   control resource use, and self-hosted verification is an explicit security
   grant. Lack of a checked-in example is not evidence an input is dead.
   Remove only after a documented deprecation/use audit. No input removal or
   release-note migration is required by this delivery.
4. **Retain the thin public wrappers and explicit authority jobs.** The docs
   and instructions wrappers delegate execution to the same run-agent workflow;
   tools-update is deterministic and intentionally receives no model secret.
   Resolve/publish YAML declares each job's authority and invokes shared CLI
   domain code. A generic generated wrapper or extra reusable layer would
   preserve the public shims while adding parameter/secret forwarding and
   review surface; it would not eliminate their interface declarations.
   Keep the explicit contracts rather than add that layer.
5. **Consolidate shared rules selectively.** Protected-severity policy now has
   one implementation in review contracts, used by both candidate preparation
   and the findings gate (the old adjudicate export remains compatible).
   Command token/prefix detection is owned by the command module and shared
   with authorization; malformed invisible-character commands keep their
   existing parser/error behavior. Adjudication schema/operation validation
   was already shared. Retain independent preflight and final trust-boundary
   checks: the gate must validate untrusted artifacts, and final `checkPullDiff`
   must validate the complete actual Git diff even when a manifest passed.
   Git transports share `safeGitArgs`/`SAFE_GIT_ENV` and filter neutralization;
   their callback/result needs differ, so a single generic process wrapper is
   declined. Further splitting `runInHome` is declined here: it owns one
   attempt/retry/repair/cleanup lifetime, and an extraction needs a distinct
   invariant rather than a line-count target.
6. **Pin original Git observations.** Resolve and canonicalize the actual Git
   directory before agent execution, including linked-worktree `.git` files.
   Reuse that pin and original worktree for baseline/final status and HEAD.
   Public `runAgent` regressions cover ordinary `core.worktree` redirection,
   linked-worktree `config.worktree` redirection, concealed HEAD movement and
   resolution failure. The three behavioral regressions failed before the fix
   for the intended reasons. This pins paths; in-place execution still does
   not contain an agent capable of replacing Git metadata itself.

### Nesting and verification limits

GitHub's current official reusable-workflow limit is ten total levels:
<https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#nesting-reusable-workflows>.
Review depth is caller → pr-review → reviewer/adjudicator (three); the existing
fleet path reaches four. Secret selection uses `needs` because call-level
secrets expressions do not admit `steps` context:
<https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability>.

Workflow contracts and actionlint verify wiring; they do not prove hosted
failed-child output propagation or live provider behavior. Missing artifacts
still fail closed. No workflow inputs were removed; release notes should say
so explicitly when publishing the planned version. No new model transport,
credentials, paid fallback or external repository mutation is included.

---
id: BL-261030-make-the-moved-base-publish
title: Make the moved-base publish test deterministic
status: open
priority: medium
scope: task
scope_estimate: S
labels:
  - test
  - flaky
assignee: null
created: 2026-10-30T19:23:49.597Z
updated: 2026-10-31T20:08:10.940Z
associated_issues: []
external_plans: []
---

## Description

src/publish/publish.test.ts "records a moved base, then refuses an older base that would undo it" fails about 1 in 10 runs. It is pre-existing on main (seen 2026-10-28 while working on PR #29), so CI can fail on unrelated changes.

## Acceptance Criteria

- The timing or ordering dependency behind the intermittent failure is identified and recorded.
- The test passes 100 consecutive local runs with no change to the behavior it protects.

## Diagnosis and resolution

2026-10-31: the test performs several real Git fetch/publish cycles under
Vitest's default five-second test budget. It passed 30 isolated baseline runs
and one ordinary full-suite run (2.61 seconds), approached the limit with four
concurrent full suites (4.76–4.86 seconds), and timed out in all six runs of a
six-suite contention check (5.00–5.23 seconds). Other long integration tests
also timed out in that stress check; it was a resource-contention experiment,
not representative evidence of normal suite reliability.

Give this integration test a scoped 15-second budget, retaining every
stale-base refusal, unchanged-remote, newer-base and idempotence assertion.
Production publishing behavior and the global test timeout are unchanged.
The historical report did not retain an error trace, so the reproduced timeout
cannot establish the cause of every previously reported failure.

Validation: 100 consecutive focused Vitest invocations passed without retries.
A repeated six-suite contention check passed all 926 tests in every suite; this
test took 3.98–4.55 seconds, below the old budget. That repeat confirms stability
but does not independently prove the higher timeout boundary was necessary.
Keep the item open until the original failure is attributed or the operator
accepts this demonstrated timeout correction as sufficient resolution.

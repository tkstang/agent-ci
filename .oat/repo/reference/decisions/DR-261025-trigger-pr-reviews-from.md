---
id: DR-261025-trigger-pr-reviews-from
title: Trigger PR reviews from the default branch with a strict gate
date: 2026-10-25
status: accepted
legacy_id: null
---

# Trigger PR reviews from the default branch with a strict gate

## Context

Consumers need a production trigger for AI pull-request review (label, comment command, dispatch). pntr used pull_request_target plus a label with a strict gate. pull_request_target and issue_comment run the workflow file from the default branch with secrets; pull_request runs the file from the pull request's merge ref, and for same-repository pull requests it also receives secrets, so a branch author could rewrite the review workflow, its allowed models or its agent-ci pin before it runs with the model credential. Until the delivery PR merges, the agent-ci workflows exist only on the project branch, so pre-merge tests can only use pull_request.

## Decision

Consumers trigger on pull_request_target (types: labeled, label agent-ci:review), issue_comment (types: created, /agent-ci-review) and workflow_dispatch (pr_number, command), calling pr-review.yml at a pinned ref. The reusable workflow's gate job is the only authority: it holds a GitHub token and no model credential, ignores bots and plain issues, requires the requester (labeler, commenter or dispatcher) to have write, maintain or admin, accepts only same-repository open non-draft pull requests (forks are skipped and never reach a credential), requires the PR author to have write (or be an allowlisted bot), and captures the head SHA that every later job uses. The workflow never runs pull-request code: reviewer passes read the PR head read-only with no setup command and no repository skills, and the gate, adjudicator, findings and publish jobs never check it out. The gate also accepts pull_request (labeled) so this repository's self-test can exercise the workflow from a branch before merge; consumers are told not to use it.

## Consequences

The consumer file, allowed models, review policy and agent-ci pin come from the default branch, so a pull request cannot change what reviews it; changes to the consumer file take effect after they merge. pull_request_target and issue_comment get read-only Actions cache tokens; workflow_dispatch keeps read-write cache access, but no job runs pull-request code that could use it. Requester and author write access is the trust boundary: a prompt injection in the pull request could still try to steer the reviewer into publishing encoded data in a finding (exact credential values are refused by the output guard), the same accepted residual risk pntr documents. The comment-command and dispatch paths are exercised only by unit and structure tests until the workflows reach main.

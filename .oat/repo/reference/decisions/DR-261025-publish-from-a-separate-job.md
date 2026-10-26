---
id: DR-261025-publish-from-a-separate-job
title: Publish from a separate job with GITHUB_TOKEN by default
date: 2026-10-25
status: accepted
legacy_id: null
---

# Publish from a separate job with GITHUB_TOKEN by default

## Context

Write authority should be separated from agent execution without new setup.

## Decision

Publishing (static-branch PR, PR comment, notifications) runs in its own job with `GITHUB_TOKEN`; a GitHub App token is optional.

## Consequences

PRs and pushes made with `GITHUB_TOKEN` do not trigger the target repository's workflows, so generated PRs get no CI unless the App token is configured; the consumer template documents this. Consumer repositories still need `AGENT_CI_SOURCE_TOKEN` for the helper checkout.

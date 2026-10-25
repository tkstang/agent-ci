---
id: BL-261025-publish-to-the-calling
title: Publish to the calling repository with an optional GitHub App token
status: open
priority: low
scope: feature
scope_estimate: S
labels:
  - publish
  - workflows
assignee: null
created: 2026-10-25T20:45:53.931Z
updated: 2026-10-25T20:45:53.931Z
associated_issues: []
external_plans: []
---

## Description

The brief's Decision says publishing uses GITHUB_TOKEN by default with an optional GitHub App token, so generated pull requests can trigger CI. Today the calling repository is always published with GITHUB_TOKEN (run-agent.yml and tools-update.yml publish checkouts use github.token when the target is not another repository; src/targets/resolve.ts picks the GitHub token whenever cross is false). Only another repository can be published with a different token, as AGENT_CI_TARGET_TOKEN. Found by the p06 docs review (reviews/p06-review-2026-10-25T203922Z.md).

## Acceptance Criteria

- `run-agent.yml`, `tools-update.yml`, `fan-out.yml` and the wrappers accept an optional publish token secret for the calling repository (referenced only in the publish job), and fall back to `GITHUB_TOKEN` when it is absent
- Workflow structure tests assert that the token reaches only the publish job, and `publisher_login` documents the identity it acts as
- `docs/configuration.md` describes the option, and a live run shows a pull request published with that token starting the repository's workflows (or the gap is recorded)

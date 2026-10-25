---
id: BL-261025-reusable-run-agent-workflow
title: Reusable run-agent workflow and publishers
status: open
priority: high
scope: feature
scope_estimate: L
labels:
  - ci
  - workflows
  - publish
assignee: null
created: 2026-10-25T05:50:35.477Z
updated: 2026-10-25T05:50:35.477Z
associated_issues: []
external_plans: []
---

## Description

Project agent-ci-v1 phase p02. Add the reusable `run-agent.yml` (workflow_call): read-only agent job, harness install for all four CLIs, per-job HOME skills install, artifacts; a separate publish job (static-branch PR create/update, PR comment, optional notification); a consumer workflow template; this repo's CI updates. `runs-on` is an input everywhere; the model credential is scoped to the agent step only. Evidence: workflow structure tests, actionlint, a live Actions run with the credential-free `fake` harness, a local `agent-ci run` + `agent-ci publish` against a test PR.

## Acceptance Criteria

- {Outcome 1}
- {Outcome 2}

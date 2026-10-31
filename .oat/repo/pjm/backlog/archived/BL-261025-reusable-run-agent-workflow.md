---
id: BL-261025-reusable-run-agent-workflow
title: Reusable run-agent workflow and publishers
status: closed
priority: high
scope: feature
scope_estimate: L
labels:
  - ci
  - workflows
  - publish
assignee: null
created: 2026-10-25T05:50:35.477Z
updated: '2026-10-25T20:27:29Z'
associated_issues: []
external_plans: []
---

## Description

Project agent-ci-v1 phase p02. Add the reusable `run-agent.yml` (workflow_call): read-only agent job, harness install for all four CLIs, per-job HOME skills install, artifacts; a separate publish job (static-branch PR create/update, PR comment, optional notification); a consumer workflow template; this repo's CI updates. `runs-on` is an input everywhere; the model credential is scoped to the agent step only. Evidence: workflow structure tests, actionlint, a live Actions run with the credential-free `fake` harness, a local `agent-ci run` + `agent-ci publish` against a test PR.

## Acceptance Criteria

- `run-agent.yml` (workflow_call) has a read-only agent job, harness install for all four CLIs, per-job HOME skills install and artifacts, and a separate publish job (static-branch PR create/update, PR comment, optional notification); `runs-on` is an input everywhere and the model credential is scoped to the agent step only
- Workflow structure tests, publisher unit tests and `actionlint` pass
- A live Actions run in `tkstang/agent-ci` with the `fake` harness, from a test PR based on the project branch, runs the agent and publish jobs and the credential-free checks (CLI `--version` for all four harnesses, Codex sandbox smoke check, skills install listing)
- A local `agent-ci run` plus `agent-ci publish` creates or updates a static-branch PR and comment in `tkstang/agent-ci` with a cheap model; edit-mode retries no longer reuse a workspace a failed attempt changed (or the limitation is documented)

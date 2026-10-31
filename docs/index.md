---
title: 'agent-ci'
description: 'Run Claude Code, Codex, OpenCode or Cursor agents against a repository from GitHub Actions or the command line, and publish the result.'
---

# agent-ci

agent-ci runs a chosen model through one of four agent harnesses (Claude
Code, Codex, OpenCode or Cursor) against a repository, then publishes the
result as a pull request, a comment or a pull-request review. It is a CLI
(`agent-ci`) plus reusable GitHub Actions workflows that call it, with a
checked-in routing table that decides which harness, credential and account
each model uses.

These pages are for the operator running agent-ci locally and wiring it into
other repositories. Start with Getting started; the Set up group covers
credentials and other repositories; Security model explains what each job
can reach.

## Contents

### Start

- [Getting started](getting-started.md) - Build the CLI, run it without a model, then run a cheap model and inspect the result.

### Use

- [Harnesses and routing](harnesses-and-routing.md) - The four harnesses, the `models.yaml` routing table and the routing policy.
- [Workflows](workflows.md) - The reusable workflows, their jobs and inputs, the consumer templates and caller permissions.
- [PR review](pr-review.md) - Request a review, how findings are checked and published, and verify-review.

### Set up

- [Configuration and credentials](configuration.md) - Every secret and token permission, repository settings, and self-hosted runners for the proxy pool.
- [Using agent-ci from another repository](fleet-repo.md) - A fleet repository for scheduled maintenance, and PR review callers per repository.

### Concepts

- [Security model](security-model.md) - Trust boundaries per job, token scoping, isolation, guards and residual risk.

### Contributing

- [Contributing](contributing.md) - Authoring conventions, the accepted information architecture and `pnpm docs:check`.

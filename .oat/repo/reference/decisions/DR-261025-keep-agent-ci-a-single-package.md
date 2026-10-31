---
id: DR-261025-keep-agent-ci-a-single-package
title: Keep agent-ci a single package
date: 2026-10-25
status: accepted
legacy_id: null
---

# Keep agent-ci a single package

## Context

agent-ci has one deployable: the CLI plus its reusable workflows.

## Decision

Single-package repository from the foundations single scaffold.

## Consequences

Revisit only if a second deployable or shared library appears.

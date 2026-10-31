---
id: DR-261025-reuse-the-earlier-prototype-s
title: Reuse the earlier prototype's code where it fits
date: 2026-10-25
status: accepted
legacy_id: null
---

# Reuse the earlier prototype's code where it fits

## Context

An earlier prototype the operator wrote has the contracts, supervisor, publishers and PR review flow agent-ci needs.

## Decision

Reuse its code, verbatim where it fits and adapted to foundations conventions where better. The operator owns that code and approved reuse on 2026-10-25, and approved publishing agent-ci on 2026-10-30.

## Consequences

Ported modules describe their behavior directly; they do not cite the prototype.

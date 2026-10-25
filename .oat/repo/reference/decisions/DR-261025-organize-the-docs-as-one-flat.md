---
id: DR-261025-organize-the-docs-as-one-flat
title: Organize the docs as one flat grouped index of reader pages
date: 2026-10-25
status: accepted
legacy_id: null
---

# Organize the docs as one flat grouped index of reader pages

## Context

agent-ci needed a docs/ tree (brief Outcome 6). Its readers are the operator in two work contexts: running agent-ci locally and from Actions (use), and wiring it into other repositories (integrate). Maintenance of agent-ci itself is covered by AGENTS.md, .oat/repo and the project journal. The anticipated reader-page count is seven, below the Flat Small size gate (about 15 pages). The approved brief already names the sections: getting started, harnesses and routing, workflows, PR review, configuration, security model, plus the fleet-repository guide the p06 dispatch added. Plain Markdown fits: no docs site is needed for a private single-package repository.

## Decision

Plain Markdown under docs/ (oat docs init --framework markdown, preset flat-small, 7 planned reader pages). One authored docs/index.md with a ## Contents map grouped under ### headings: Start (getting-started), Use (harnesses-and-routing, workflows, pr-review), Set up (configuration, fleet-repo), Concepts (security-model), and Contributing. One page per job; each fact has one owning page and other pages link to it (credentials live in configuration.md, trust boundaries and residual risk in security-model.md, routing policy in harnesses-and-routing.md). Workflow inputs stay canonical in the workflow files; pages summarize and link. Rejected: Toolkit and CLI folders (tools/, workflows/) and Task Type folders, which would hold one or two pages each at this size. pnpm docs:check (src/docs-check/) enforces the index, metadata and link contract.

## Consequences

Graduate to folders when the tree passes about 15 reader pages, when one ### group passes about 8 entries (that group becomes a folder with its own index.md), or when a second distinct reader population appears (for example consumers outside the operator's repositories): re-run the selection with the Toolkit and CLI preset as the likely destination. New pages go into an existing group and the index Contents in the same change; docs:check fails on an unlisted page.

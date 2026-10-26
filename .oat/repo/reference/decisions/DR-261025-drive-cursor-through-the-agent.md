---
id: DR-261025-drive-cursor-through-the-agent
title: Drive Cursor through the agent CLI, not @cursor/sdk
date: 2026-10-25
status: accepted
legacy_id: null
---

# Drive Cursor through the agent CLI, not @cursor/sdk

## Context

pntr used the Cursor SDK local runtime. agent-ci wants one adapter shape for all four harnesses.

## Decision

The cursor adapter runs `agent -p --trust --output-format json --model M` with `CURSOR_API_KEY` in the environment only.

## Consequences

No SDK custom tools or model catalog API; models come from models.yaml. Revisit if PR review on Cursor needs in-loop tools.

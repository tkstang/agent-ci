---
id: DR-261025-use-the-local-proxy-pool
title: Use the local proxy pool for Claude only in local runs
date: 2026-10-25
status: accepted
legacy_id: null
---

# Use the local proxy pool for Claude only in local runs

## Context

The operator routes Claude through CLIProxyAPI today and approved a few cheap local calls on each subscription, including the employer account, on 2026-10-25. Pooling subscription credentials raises terms questions in unattended CI.

## Decision

Claude pool routes carry `account: pool`; they run only locally with `--allow-pool` and are refused whenever CI or GITHUB_ACTIONS is set. CI routes use a personal `CLAUDE_CODE_OAUTH_TOKEN` or an API key, never the pool.

## Consequences

Local end-to-end, publish and review runs in p01-p04 may use the pool with cheap models only.

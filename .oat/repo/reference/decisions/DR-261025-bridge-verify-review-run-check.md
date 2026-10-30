---
id: DR-261025-bridge-verify-review-run-check
title: Bridge verify-review run_check through an agent-ci MCP server
date: 2026-10-25
status: accepted
legacy_id: null
---

# Bridge verify-review run_check through an agent-ci MCP server

## Context

verify-review gives the PR reviewer a run_check tool, and the brief left the bridge open (Known Unknown: MCP server vs OpenCode plugin, settled by p04). The tool must reach the model inside agent-ci's isolated home, environment allowlist and read-only posture, and no MCP server a repository or a home configures may start alongside it. Live probe 2026-10-25 (.oat project research p04-tool-bridge-probes-2026-10-25.md, decoy MCP configs committed in each workspace): claude 2.1.310 offered and called the tool from --mcp-config under --strict-mcp-config and --setting-sources user, and refused it under dontAsk without an allow rule naming it; codex 0.163.0 called it from a CODEX_HOME config table, and refused it ('requires approval, but approval policy is never') without approval_mode = approve on the tool; opencode 2.0.27 connected the server but offered its tools only inside the execute code-mode runtime that p02 denied (network and worktree tools); Cursor listed a home server as ready but did not call it in ask mode, and its account exposes cloud connector tools to headless runs. No decoy server started on any harness.

## Decision

The run_check bridge is agent-ci's own dependency-free stdio MCP server (src/review/checks-mcp.ts, server agent-ci-checks, one tool run_check whose name argument is an enum of the configured checks). It executes nothing: it serves results the verify stage recorded (see the companion decision on where checks run). Adapters declare supportsToolBridge. claude: --mcp-config with exactly that server plus --allowedTools mcp__agent-ci-checks__run_check, keeping --tools Read,Grep,Glob,Skill, --strict-mcp-config and --setting-sources user. codex: one mcp_servers.agent-ci-checks table in the isolated config.toml with enabled_tools = [run_check] and approval_mode = approve for that tool. opencode and cursor do not support it: the request gate and the run core refuse a verify-review route on them with E_POLICY_HARNESS before anything runs, instead of reviewing without the tool. The fake harness supports it for credential-free tests and the Actions self-test (its CLI calls the server itself). An OpenCode plugin was rejected: it would cover one harness and run as in-process JavaScript with the harness's privileges.

## Consequences

Verify-review needs a Claude or Codex reviewer route (and the second reviewer, when enabled, too). Re-run the probe when a pinned harness version changes. OpenCode can join if it gains a way to expose MCP tools outside code mode, or through a custom-tool bridge proven safe; Cursor can join if ask mode calls home MCP tools and account connectors can be switched off. The Cursor connector exposure is recorded as a Deferred Finding because it affects existing Cursor routes too.

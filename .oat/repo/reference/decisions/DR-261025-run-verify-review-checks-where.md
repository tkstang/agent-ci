---
id: DR-261025-run-verify-review-checks-where
title: Run verify-review checks where no model credential exists
date: 2026-10-25
status: accepted
legacy_id: null
---

# Run verify-review checks where no model credential exists

## Context

verify-review's run_check executes pull-request-controlled code (tests, linters, build scripts). A reviewer harness holds the model credential in its process environment and an isolated home that can hold a seeded login. Any process with the same uid in the same job can read /proc/<pid>/environ, write the harness home, skills and config, plant a background process that outlives the check, follow symlinks out of a copy, or rewrite files a later stage reads. On GitHub-hosted runners the runner user also has passwordless sudo, so no boundary inside one job (separate uid, sandbox, namespaces) holds against code that runs there, and every secret a job references is in the runner worker's memory. p02 already drew the same line for setup_command (a separate credential-free job, no helper token, the reader is the boundary).

## Decision

Checks run only where no model credential exists, and run_check serves their recorded results. In Actions, pr-review.yml (verify input, default false) runs a verify job between the gate and the reviewer jobs: contents read, no model secret, no AGENT_CI_SOURCE_TOKEN (agent-ci arrives as a helper bundle the gate job builds and uploads, downloaded by artifact id and checked against its sha256), the PR head checked out without persisted credentials. Locally, agent-ci review run --verify runs the checks in their own worktree before the reviewer's home root exists or any harness starts. The checks are a fixed allowlist in .github/agent-ci/checks.yaml read from the base commit (optional setup with network, at most 10 checks); the model can only pick a name. Each check runs in a fresh copy of the post-setup tree without .git, with an environment allowlist that never passes a token or credential variable, a scratch HOME, a PATH without checkout entries, a deadline, a 1 MiB output capture and a process-group kill, plus network isolation where the host allows it: Linux user, pid and loopback-only network namespaces (unshare; the verify job enables unprivileged user namespaces like the Codex step), macOS sandbox-exec (writes confined to the run directory, reads of agent-ci output and home roots and of credential stores denied, network limited to loopback). checks.json records each result with an evidence id = sha256 over (check name, command, head SHA, exit code, output digest). The verify job's output is untrusted: the reviewer pass validates it against the spec (repository, head, config digest, configured checks in order, every id recomputed), serves it through the MCP bridge, and copies the validated file into its own digest-bound pass output; the findings gate checks citations against that copy only.

## Consequences

Every configured check runs once per verify request whether or not the reviewer asks for it, and the model cannot pass arguments. Evidence is attributable to the PR head, not an attestation: PR code controls the verify job, so it can make its own checks report anything, which it could already do by changing the code under review. Forged or altered entries fail recomputation and citations of unknown ids are dropped as invalid evidence. Checks lose loopback-free network access where isolation is available, and see no .git. Local --verify still runs PR code on the operator's machine; without sandbox-exec or user namespaces the containment is hygiene only (recorded per entry as isolation none). Residual risks are listed under the project's Deferred Findings.

## Amendment 2026-10-25 (p04 review r1)

- **macOS sandbox-exec is not a credential boundary.** A sandboxed command can read the initial environment of any same-user non-platform process (agent-ci itself, a later harness, other tools) through `KERN_PROCARGS2`. It can also query the login Keychain through securityd. Probes with a synthetic value and a negative control showed this. No profile rule tried (`sysctl-read` denials, `process-info*`/`process-info-pidinfo` scoped to others, securityd `mach-lookup` denials) blocks the read without breaking ordinary programs. Local `agent-ci review run --verify` therefore refuses on macOS, and on Linux without verified user namespaces, unless the operator passes `--verify-trust-pr-code`, which acknowledges that the PR code runs as them. The sandbox profile stays as hygiene (writes confined, network limited to loopback, agent-ci directories, credential stores and shell rc files denied) and is not claimed as isolation.
- **Linux isolation tools are launcher-verified.** `unshare`, `mount` and `ip` resolve only from fixed system paths, as root-owned files that group and others cannot write, under directories with the same properties. They run by absolute path, never through PATH. Without verified `unshare` and `mount`, the recorded isolation is `none`, and local runs refuse.

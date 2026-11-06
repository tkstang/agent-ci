# OAT Current State

This file is the active operating picture and lives under `pjm/` (the
operational layer), not `reference/`. To reduce cross-worktree conflicts, keep
edits append-mostly and scoped to the section you own; avoid rewriting whole
sections another branch may also touch.

## Canonical References

<!-- List durable repo references, source-of-truth docs, dashboards, or processes here.
Decisions live in reference/decisions/ (one file per record); link them rather than
copying their content here. -->

- `docs/index.md` — the user documentation (getting started, routing, workflows, PR review, configuration, fleet repositories, security model); `pnpm docs:check` keeps its index and links valid.
- `models.yaml` — the routing table and its policy notes.
- `.github/workflows/` (reusable workflows) and `consumer-workflows/` (copy-in callers).
- `AGENTS.md` — toolchain, non-negotiables, definition of done.
- Decisions: `reference/decisions/index.md` (routing policy: DR-261025-route-models-through-a-checked; harness CLIs: DR-261025-run-agents-through-harness; tsrs: DR-261025-use-tsrs-instead-of-tsc; docs IA: DR-261025-organize-the-docs-as-one-flat).
- Delivery history: OAT project `agent-ci-v1` shipped and is complete and archived. No OAT project is active. The native [Review and fleet readiness delivery goal](backlog/reviews/review-and-fleet-readiness-goal.md) is active as of 2026-10-31.

## What's Implemented

Current baseline (2026-10-31): the public repository was recreated with root
`8ecf26a`; `main` at `5673eeb` includes README/publishing PRs #1–#2,
reviewer, runner/routing, simplification and fleet/private-output PRs #3–#6,
direct Sol Low adjudication PR #7, and the isolated transport design in #8.
Release `v0.1.0` is published at `50d8e80`; it does not claim live qualification.
Public-source cleanup is complete. Earlier PR numbers and commit pins
in the historical snapshot below belong to the previous repository history.

<!-- Summarize shipped capabilities and important repo conventions here. -->

As of 2026-10-30. agent-ci-v1 (phases p01-p06) merged as PR #25 on 2026-10-26; PR #28 (DeepSeek V4.1 Flash and GLM 5.3 Flash OpenCode routes) and PR #29 (`AGENT_CI_PROXY_BASE_URL` pool-origin override) merged after it. On 2026-10-30 `main` was squashed to one parentless commit (`369a99d`) ahead of making the repository public; pull-request metadata and old branches still reference the earlier history. No release tag yet. The user-facing description of each capability is in `docs/`; this list is the operating summary.

- **CLI** `agent-ci` (one JSON envelope on stdout, `E_*` codes, logs on stderr): `run`, `route`, `models`, `doctor`, `validate`, plus the workflow-step commands `harness`, `skills`, `publish`, `review`, `preset`, `targets`, `tools-update`, `notify`, `workspace`, `digest`, `helpers`. New workflow-step logic becomes a `CommandSpec` in `src/commands/`.
- **Harness adapters** for `claude`, `codex`, `opencode`, `cursor` and a credential-free `fake` harness, each with a read-only and an edit posture; stdin closed, deadline with process-group kill, output cap, environment allowlist plus only the route's credentials, one isolated home root per run (login stores and executable harness config cleared each run; seeded logins local only).
- **Routing** (`models.yaml`, `src/routing/`): explicit model `family`; cheap OpenCode Go routes (`deepseek-v4.1-flash-opencode`, `glm-5.3-flash-opencode`, `grok-4.7-opencode`) for fleets; an optional `AGENT_CI_PROXY_BASE_URL` secret replaces the loopback origin of every pool route (origin only, masked, passed only to pool-route agent and review steps); Claude only on the claude harness; no subscription-to-paid fallback or automatic fallback into account class `work` (`--route` is the only way to a paid route); pool routes need the opt-in and run in CI only on a self-hosted runner; Claude Code pool routes are now allowed by the operator's revised policy; login routes local only.
- **Run core**: prompt builder, supervisor with per-attempt workspace copies for edit retries, Zod result contracts (report, changes, issues, verdict), secret guard, `run-result.json`, `run-log.jsonl`, `changes.json`.
- **run-agent.yml** (p02): resolve, credential-free setup, agent (behind `agent-job.yml`, one route credential) and publish jobs; static-branch pull requests and PR comments without force pushes; optional webhook notification.
- **PR review** (p03): `pr-review.yml` and `agent-ci review` stages; label, comment or dispatch behind the write-access gate (forks never reach a credential); one or two reviewer passes, tool-free adjudication (Claude/fake supported; direct Sol Low pool transport implemented), deterministic findings gate, one inline review plus an updatable summary; `agent-ci review run` locally.
- **verify-review** (p04): checks from `.github/agent-ci/checks.yaml` on the default branch (or `verify_config_ref`) run in a secret-free verify job (GitHub-hosted unless `verify_on_self_hosted`); reviewers read results through the `run_check` MCP bridge (Claude and Codex only) and cite evidence IDs the gate recomputes. Every local `--verify` run needs `--verify-trust-pr-code`.
- **Wrappers and fan-out** (p05): `docs-update.yml`, `instructions-update.yml`, `tools-update.yml` with path policies; `fan-out.yml` over `targets.yaml` with scoped write and read target tokens; consumer and fleet templates.
- **Documentation** (p06): `docs/` (plain Markdown, one grouped index) and `pnpm docs:check` in CI; README is a short entry point.
- **Toolchain**: `tsrs` for typecheck and build (pinned pre-release), Oxc, Vitest, Zod 4, `yaml`.
- **Verified live**: 2026-10-25, one cheap run per harness locally; fake-harness Actions self-tests of `run-agent.yml`, `pr-review.yml` (including verify-review) and `fan-out.yml`; local model-backed review, verify-review and docs-update runs. 2026-10-30, the private fleet (`tkstang/agent-ci-private-fleet`, pinned to `369a99d`) ran a model-backed `fan-out.yml` docs-update with `deepseek-v4.1-flash-opencode` on GitHub-hosted runners and merged its pull request, then a `fake-edit` run after the re-pin. Not yet live: the default-branch review triggers, cross-repository targets (no target tokens yet), and a pool route on a self-hosted runner (the runner VM awaits admission).

## What's Next

<!-- Track near-term follow-up work, known gaps, and active handoff context here.
Track concrete items in pjm/backlog/ and sequencing in pjm/roadmap.md; keep this
section to a short narrative pointer. -->

The active [Review and fleet readiness goal](backlog/reviews/review-and-fleet-readiness-goal.md)
records the merged #3–#7 deliveries and exact source commits. The selected defaults
and revised Claude-pool policy are in
[Production reviews and pool CI](../reference/decisions/DR-261031-production-reviews-and-pool-ci.md).
Sol High is the primary; Opus High is optional; Sol Low adjudication uses an
approved direct pool transport merged in
[PR #7](https://github.com/tkstang/agent-ci/pull/7), after exact-head hosted CI
and independent review. Generic defaults enable
only the primary. New production routes are not live-qualified.

**BL-261025-close-remaining-claude-only — Close remaining Claude-only policy
name-check gaps** and **BL-261025-post-v1-simplification-pass — Post-v1
simplification pass** shipped in reviewed, merged source and are archived.
**BL-261025-self-hosted-runner-and-proxy — Self-hosted runner and proxy readiness**
remains open for coherent runner upgrade/admission and live pool/JIT proof;
source release publication is complete. **BL-261025-fleet-repositories-merged — Fleet repositories: merged
target lists and protected artifacts** remains open: merging and private-output
controls shipped, but artifacts remain plaintext. The operator selected isolated
transport for full support; the [proposed design](../reference/research/fleet-artifact-transport.md)
retains platform qualification and service provisioning gates.

Private-fleet [caller #5](https://github.com/tkstang/agent-ci-private-fleet/pull/5)
is merged, pins `v0.1.0`, removes the retired source-token mapping and stays
disabled/manual-only. Runner
[reservation #6](https://github.com/tkstang/actions-runner/pull/6) stacks on its
existing PR #4 and refuses unqualified fleet starts. The operator subsequently preauthorized discussed merges, runner setup and
bounded qualification, release publication and deletion of unnecessary secrets.
No host activation or dispatch ran in this reconciliation. The source secret
was subsequently deleted after the verified no-reader checks below. The installed pilot remains
personal-skills-only. Target-token provisioning and privileged host admission
remain user-owned. Retired source-secret deletion is approved after the caller migration and a
fresh no-reader/active-run check, including the stale manual branch. Publisher-token support and native
Codex persistent login remain Next, outside this goal.

Read-only setup reconciliation confirms installed runner source `4e72f1d`,
unchanged reviewed boot, and no activation receipt or watcher plist. Later
retained recovery/JIT success records supersede the old unexecuted-prompt
assumption. Runner #5 has newer corrections and uncommitted upgrade work in a
separate checkout; reconcile that lane before upgrading or activating #6.
Target PAT creation remains user-owned; a private pilot is selected.

The private-fleet migration #5 merged as `fb62cc5` with `v0.1.0` and stays
disabled/manual-only. The old manual branch received the same reviewed disabled
workflow without rewriting history. A fresh scan found no source-token readers
at any of the three branch tips, no tags and no active runs; the retired
`AGENT_CI_SOURCE_TOKEN` was deleted and absence verified. Model/proxy secrets
remain. The dated reconciliation below supersedes this snapshot's target-token
and runner setup status.

## 2026-11-03 readiness continuation

The source baseline for artifact-conformance preparation is `faf1fc8`, including
merged versioned-consumer/status PR #9 and ready-PR CI trigger PR #10. The target
write/read secret names are present in the private caller's metadata; the retired
source-token secret is absent. Secret presence does not prove live target access.

Runner reservation #6 merged as `587f79e` after runtime prerequisites #4/#5. Its
integrated source passed 243 tests and 50 applicable Apple-Python checks. A later
runner-owner report describes replacement/simplification in runner #8, installed
VM-config and token-scope guards from #9 (`118a8b2`), successful personal-skills
wake-on-demand and measured idle shutdown. Those live observations are reported
by the owning runner thread, not independently re-proved here. The old launchers,
six/seven-account assumptions and receipt checklist must not be replayed as current
operating instructions. Agent-ci fleet admission remains unqualified. The owner
confirmed the dormant fleet guards remain in current source and the installed
configuration still contains personal-skills only. Its startup scope check
requires the token's private-repository set to equal the configured set: changing
only one side interrupts the pilot. Exact caller-job evidence and a reviewed
admission change precede a coordinated token/configuration maintenance window.
Live seventh-account provisioning and current bootstrap behavior remain unchecked.

The [artifact identity conformance packet](../../../docs/artifact-conformance.md)
prepares synthetic nested/matrix/repeated/optional workflow observations. No live
probe, broker, encryption key, service provisioning or model dispatch is performed
by this preparation. Diagnostic decoding does not verify JWT signatures or prove
complete-graph assignment uniqueness. The delivery goal and both remaining
backlog items stay open. Service packaging, hosting and key custody remain pending.

## 2026-11-04 conformance refusal and runner-owner update

Artifact-conformance [PR #12](https://github.com/tkstang/agent-ci/pull/12) was
squash-merged as `7f94ad35d3100e5a4bd0e9779b061fe936e65290` after fresh hosted
verify/actionlint and the final review/comment sweep. Its tree matches the
independently reviewed head `3f56021e3fd20f8cbdc577ac8ae5b62539033c26`.
The operator approved three synthetic attempts, bounded to 22 capture jobs.
The optional-off run [41902471583, attempt 1](https://github.com/tkstang/agent-ci/actions/runs/41902471583/attempts/1)
ran six captures; optional-on [41902498611, attempt 1](https://github.com/tkstang/agent-ci/actions/runs/41902498611/attempts/1)
and its [complete rerun, attempt 2](https://github.com/tkstang/agent-ci/actions/runs/41902498611/attempts/2)
ran eight each. All caller and reusable revisions matched the merged source.
Every capture failed with `E_INVALID_INPUT` before requesting OIDC, and no
artifacts were uploaded. The grouped preflight result does not identify the
exact failed check. Attempt-specific Jobs pages and fixed failure envelopes
were retained privately; no claims were observed or identity qualification
established. The approved execution budget is exhausted. A diagnostic follow-up
adds closed refusal reasons without relaxing validation; its merge and further
live probes require new approval.

The runner owner reports that the token scope and dormant fleet configuration
were updated together and passed deployment/startup scope checks. The fleet
entry remains `enabled: false`, with `job_names: []`, manual dispatch only and
one shared slot. The owner reports runner `main` at `4c0f083` after installer
PR #10, while installed runtime remains `118a8b2`. These owner-reported facts
supersede the prior token/configuration maintenance dependency; no further
token or fleet-entry change is needed for the reported admission sequence.
Exact current-source production nested job identities, reviewed list matching
and removal of dormant refusals, the owner's maintenance window and guest
account/unit verification, and one owner-approved manual dispatch remain.
The synthetic OIDC packet does not supply the production admission list.
Host, service and credential ownership stays with the runner owner. Artifact
encryption, live model qualification and the delivery goal remain incomplete.

## 2026-11-06 request-credential bound follow-up

Diagnostic [PR #13](https://github.com/tkstang/agent-ci/pull/13) merged as
`c3d87280dc418ef7894b16f6ff058f023d58dc6a`. Its approved optional-off
[run 42279537227, attempt 1](https://github.com/tkstang/agent-ci/actions/runs/42279537227/attempts/1)
matched that caller/reusable source and executed six captures. All returned
`E_INVALID_INPUT` with `request_credential_too_long` before HTTP; zero artifacts
were uploaded. This identifies the credential-size guard for this attempt only;
the earlier 22 captures' exact refusal cause remains unknown. No credential value
or actual length was exposed, and the single-attempt allowance is exhausted.

The narrow follow-up raises only the request-credential cap from 4,096 to 16,384
JavaScript string characters, a finite local limit chosen for headroom rather
than a GitHub maximum or compatibility guarantee. URL, response and returned-JWT
bounds and destination/confidentiality controls remain unchanged. The operator
separately preauthorized merging this fix after independent review and hosted CI,
then one optional-off probe of at most six capture jobs followed by inspection
and stop. That new source has not run live. No host or credential change is
included, and identity/encryption qualification remains incomplete.

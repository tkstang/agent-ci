# Goal: Review and fleet readiness

## Contract

- **Activated:** 2026-10-31 by the operator: complete selected follow-ups
  1, 3, 4 and 5, starting with runner/proxy readiness after reviewer changes.
  The native delivery goal is active; no token or time budget was requested.
- **Outcome:** production review configuration, a qualified runner/proxy path,
  stronger routing guards, simpler execution/workflow boundaries, and fleet
  configuration with protected private-target artifacts and logs.
- **Endpoint:** acceptance of the complete selected scope, with independently
  reviewed changes and the live evidence required by each backlog item.
  Review-ready pull requests do not establish merged or live acceptance.
- **Deferred:** optional publisher-token support and native Codex persistent
  ChatGPT-login support stay in Next. Existing publishing-test follow-up is
  outside this goal; PR #2 merged as `95fec188` and its item remains open.

## Ordered delivery batches

1. **Reviewer configuration prerequisite.** Sol 6.1 High primary reviewer;
   Opus 5.5 High second reviewer on request; Sol 6.1 Low adjudicator.
   Reusable defaults enable the primary only; the operator's callers enable
   primary plus adjudicator. Add and verify tool-free Codex adjudication,
   exact model/effort routing, and Claude Code pool CI credential wiring.
   The operator explicitly reversed the earlier Claude pool CI refusal.
2. [**BL-261025-self-hosted-runner-and-proxy — Self-hosted runner and proxy readiness**](../items/BL-261025-self-hosted-runner-and-proxy.md).
   Prepare the integration immediately after reviewer configuration;
   establish approved host admission, runner registration, proxy reachability
   and one live opt-in pool job. Prepare the agreed versioned release and
   consumer references. Host approval does not block independent code batches.
3. [**BL-261025-close-remaining-claude-only — Close remaining Claude-only policy name-check gaps**](../archived/BL-261025-close-remaining-claude-only.md).
   Implemented load-time guards for separator-less Claude names and Cursor
   automatic routers, with explicit Grok and Claude Code pool controls
   preserved. Archived with the implementation delivery; independent review
   and merge remain pending.
4. [**BL-261025-post-v1-simplification-pass — Post-v1 simplification pass**](../archived/BL-261025-post-v1-simplification-pass.md).
   Implemented original Git-context pinning and per-pass reviewer/adjudicator
   credential boundaries, shared severity/command rules and an early local
   trust check. All six areas have evidence-backed dispositions in the
   archived record; no workflow inputs were removed. Pending independent
   review and merge.
5. [**BL-261025-fleet-repositories-merged — Fleet repositories: merged target lists and protected artifacts**](../items/BL-261025-fleet-repositories-merged.md).
   Deliver validated file/JSON target merging, private-target log protection,
   optional authenticated encryption across every artifact path, and public
   and private fleet templates/docs. Encryption and confidentiality require
   their own focused verification; masking logs alone is insufficient.

## Authority and execution

- **Workspace:** Dev Mini, existing T3 worktree
  `/Users/tstang/.t3/worktrees/agent-ci/t3-623cc11b`.
  Initial batch branch `feat/reviewer-model-defaults`, baseline `95fec188`.
  Use coherent branches/PRs for later batches and preserve earlier deliveries.
- **Authorized:** local implementation, focused checks, Conventional Commits,
  SSH pushes and independently reviewed PRs within agent-ci's selected scope.
- **Separately gated:** merges, force-pushes, external-repository mutations,
  credential creation/change/deletion and privileged runner activation.
  Prepare concrete changes and requests before asking for the relevant action.
  Do not publish a release before its source changes are approved and merged.
- **User-owned setup:** target write/read tokens, target-repository selection
  and privileged runner admission. Existing secret names do not prove valid
  credentials or grant mutation authority.
- **Persistent constraints:** credential values and the non-loopback proxy
  origin never enter output or public records. The proxy origin stays in
  secrets. Claude runs only through Claude Code. Pool CI remains self-hosted
  and explicitly opted in. No subscription-to-paid fallback; never use
  `CODEX_OPENAI_API_KEY`. Workflow-file pushes use SSH.
- **Ownership:** one integration owner in the root; bounded reconnaissance,
  implementation and review workers own declared non-overlapping scopes.
  Serialize shared model/schema/workflow changes and Git-index operations.
- **Reviews:** author checks plus independent Sol 6.1 High review required for
  each delivery and integrated acceptance. An Opus cross-provider opinion is
  recommended as an optional additional check for adjudicator/credential/
  artifact security changes; it is not a substitute for verified behavior.
- **Verification:** tests at the changed public boundaries; typecheck, lint,
  format, agent checks and docs/actionlint/build where applicable. Complete
  the repository's worktree validation before push. Live route, runner and
  artifact evidence is separate from static/unit evidence and uses only
  authorized credentials and routes.

## Evidence and remaining work

- Baseline `main` is `95fec188`; public-source cleanup and earlier README/
  publishing-timeout PRs are merged. PJM adoption is declared and doctor passes.
- [Reviewer preparation PR #3](https://github.com/tkstang/agent-ci/pull/3),
  head `587d1b3`: all 934 tests and required local checks passed; independent
  correctness, testing, complexity and docs reviews are clear. Hosted verify
  and actionlint passed. Ready for separately approved merge. New production
  aliases remain unqualified; generic defaults enable primary only.
- Pinned Codex 0.163.0 has no verified global tool-free CLI/app-server mode.
  Its adapter capability remains false. A direct tools-empty Responses request
  through the existing subscription pool is proposed for Sol Low adjudication;
  the operator's choice is still pending. Do not bypass the capability guard.
  Model/effort and revised Claude-pool intent is recorded in
  [Production reviews and pool CI](../../../reference/decisions/DR-261031-production-reviews-and-pool-ci.md).
- [Runner/routing PR #4](https://github.com/tkstang/agent-ci/pull/4),
  head `bd82670`: label-array support and Claude-name/automatic-selector guards.
  All 958 tests and local gates passed; independent reviews clear after a
  planning-text correction. Claude-only gaps archived in the delivery;
  merge remains gated. The [runner packet](runner-proxy-readiness.md) records
  exact admission/qualification/release work. No host activation or live
  pool run is claimed. An idle JIT runner count alone proves no deployment
  state; the fixed runner allowlist still excludes the private fleet.
- [Simplification PR #5](https://github.com/tkstang/agent-ci/pull/5),
  head `b8c57ba`: original Git observations pinned, reviewer/adjudicator
  credentials isolated, policy rules shared, and local trust rejected early.
  All 961 tests and local gates passed; independent reviews clear after a
  documentation count correction. Six-area dispositions are in the archived
  item; no public workflow inputs removed. Hosted failed-child output
  propagation remains unverified and missing artifacts fail closed.
- The stacked PRs target their parent branches. Repository CI currently
  triggers only for PRs into `main`; retarget/update and hosted validation
  are required after the separately approved parent merges.
- Fleet file/JSON merging and private-output controls are implemented on
  `feat/fleet-target-inputs-and-private-output`, pending final validation and
  review. Public/private templates are prepared; no external caller or target
  selection changed. Artifacts remain plaintext and private-output mode does
  not hide Actions metadata. The
  [fleet confidentiality proposal](fleet-confidentiality-design.md) records
  the pending choice for shared-key authority versus preserved verification/
  setup isolation. No encryption key or transport has been introduced.
- External runner admission and private-fleet caller migration PR preparation
  was requested for separate approval; no answer or mutation yet. The caller
  still needs a valid source pin and retired source-token input removed.
  Secret deletion requires its own approval and a fresh no-reader check.
- Target tokens, target selection and privileged host admission remain
  user-owned. Release publication follows approved source merges and separate
  publication approval. No model-backed qualification or paid fallback ran.
- Goal remains active and incomplete. Remaining work includes Sol adjudication,
  approved runner/caller integration, live pool evidence, versioned release,
  artifact encryption and final integrated acceptance.

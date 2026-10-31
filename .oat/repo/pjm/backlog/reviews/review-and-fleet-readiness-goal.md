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
3. [**BL-261025-close-remaining-claude-only — Close remaining Claude-only policy name-check gaps**](../items/BL-261025-close-remaining-claude-only.md).
   Harden separator-less Claude names and ambiguous automatic routers while
   preserving the explicit non-Claude control and Claude Code pool support.
4. [**BL-261025-post-v1-simplification-pass — Post-v1 simplification pass**](../items/BL-261025-post-v1-simplification-pass.md).
   Start with in-place Git-context protection and per-pass reviewer credential
   boundaries. Assess all six recorded areas; simplify or document an
   evidence-backed reason to retain each. Preserve required verification,
   isolation and credential guarantees rather than removing layers wholesale.
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

- `main` at `95fec188` includes the merged publishing timeout improvement.
  Initial working tree was clean. PJM adoption is `declared`; doctor passed.
- Reviewer configuration is not implemented yet. Existing Codex adjudication
  is refused because the adapter declares no verified tool-free mode; do not
  bypass this guard merely to make a model default resolve.
- Pinned Codex 0.163.0 source confirms that its global `ToolPolicy` belongs to
  the embedding-host extension interface, not CLI/app-server configuration.
  A direct tools-empty Responses request through the existing subscription
  pool is the minimum proposed alternative for Sol adjudication. The
  operator's transport choice is pending; primary reviews retain Codex CLI.
- The accepted model/default and Claude-pool policy is recorded in
  [Production reviews and pool CI](../../../reference/decisions/DR-261031-production-reviews-and-pool-ci.md).
  This records intent, not shipped or live-qualified behavior.
- Neither source nor private-fleet repository listed a registered self-hosted
  runner at the last read-only check. The runner-related external PR remains
  open; its host proof and admission are not acceptance evidence yet.
- The runner's fixed repository/workflow/job allowlist does not admit
  `agent-ci-private-fleet`. Completing its existing personal-skills pilot
  alone would not supply a fleet runner. A narrowly scoped, separately
  authorized admission change and agent-ci harness/proxy qualification are
  required; preserve the existing recovery proof and deployment pins.
- The private fleet still needs an authorized caller migration from its
  unavailable old commit and retired source-token argument. Secret deletion
  requires explicit approval and a fresh proof that no workflow reads it.
- Next: verify supported tool-free Codex execution and exact effort routing,
  then implement the first coherent reviewer-configuration delivery.
- Completion audit remains pending for every batch above.

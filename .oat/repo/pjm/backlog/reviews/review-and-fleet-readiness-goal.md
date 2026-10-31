# Goal: Review and fleet readiness

## Contract

- **Activated:** 2026-10-31 by the operator: complete selected follow-ups
  1, 3, 4 and 5, starting with runner/proxy readiness after reviewer changes.
  The delivery objective remains active; no token or time budget was requested.
  The native goal tool still records an earlier blocked state and cannot be
  resumed through its agent API; new approvals authorize the work below.
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
   preserved. Archived with the independently reviewed implementation delivery;
   merged in PR #4.
4. [**BL-261025-post-v1-simplification-pass — Post-v1 simplification pass**](../archived/BL-261025-post-v1-simplification-pass.md).
   Implemented original Git-context pinning and per-pass reviewer/adjudicator
   credential boundaries, shared severity/command rules and an early local
   trust check. All six areas have evidence-backed dispositions in the
   archived record; no workflow inputs were removed. Independently reviewed
   and merged in PR #5.
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
- **Additional approvals:** the operator approved direct tool-free Sol Low
  adjudication through the existing pool; preparation of external runner and
  private-fleet draft PRs; and ordered merges of agent-ci #3–#6 after hosted CI.
  Those four merges are complete. The operator separately approved #7 after
  exact-head hosted CI; it is merged. The operator also selected isolated
  artifact transport for full support. External approval covers PR preparation only.
- **Separately gated:** any further merge, force-push, credential creation/
  change/deletion, privileged runner activation and release publication.
  Prepare concrete changes and requests before asking for the relevant action.
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

The four reviewed source deliveries were squash-merged in order after each
passed fresh hosted `verify` and `actionlint`. The final premerge local gate
passed 977 tests and the required checks. Label-gated self-tests were skipped;
this is not live model or runner qualification. Current merged source is
`50d8e809eb843c164988ff0cdc076d14aa604174` (including the separately approved #7).

| Delivery                                                                     | Merge commit                               | Result                                                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [Reviewer defaults #3](https://github.com/tkstang/agent-ci/pull/3)           | `da58e836420ea6ad424d07c88a3752ce2eed0dd3` | Sol High primary, optional Opus High, Sol Low adjudicator configuration; generic primary-only default.                                         |
| [Runner/routing guards #4](https://github.com/tkstang/agent-ci/pull/4)       | `cdbf974e9a382a7db9b981ec6d7ae92aba2192c6` | Label arrays, Claude-only name guards and automatic-router refusal.                                                                            |
| [Simplification #5](https://github.com/tkstang/agent-ci/pull/5)              | `e8c6bca7ad8bd88c7a4edccc398467fd6f4b0ae9` | Original Git observations pinned, per-pass credential isolation, shared policy and early local trust checks.                                   |
| [Fleet inputs/private output #6](https://github.com/tkstang/agent-ci/pull/6) | `2c9c777dc8d2f54185f46eb8b46baaf741fe21c2` | Validated file/JSON merging, private-output suppression and caller templates. Artifacts remain plaintext and Actions metadata remains visible. |

Pinned Codex 0.163.0 has no verified global tool-free CLI/app-server mode;
its adapter capability remains false. The approved direct Responses transport
for Sol Low was squash-merged in [PR #7](https://github.com/tkstang/agent-ci/pull/7)
as `50d8e809eb843c164988ff0cdc076d14aa604174`, after hosted verify/actionlint
passed at approved head `9b6f181b2b691ac05a0a79873eb8be7b766ce89c`.
It has shared eligibility gates, strict structured output, no tools, no redirects
or paid fallback, bounded bodies/retries/deadlines and full-envelope leak guards.
The final local gate passed 1,036 tests and required checks; independent
correctness/security, testing, complexity and documentation reviews, including
follow-up confirmation, found no remaining findings. No live transport proof is
claimed. The operator's reviewer-plus-adjudicator caller still needs preparation
and live acceptance.

External drafts prepared under the operator's PR-only approval:

- [Private-fleet caller #5](https://github.com/tkstang/agent-ci-private-fleet/pull/5),
  head `bc8da29599bcd3eab974ea0a53b610ae902f52f6`: pins the existing merged
  agent-ci source, removes the source-token mapping, requires dedicated labels,
  private output and one parallel target, and stays manual-only/disabled behind
  `AGENT_CI_FLEET_ADMITTED`. Target membership and the DeepSeek maintenance
  default are unchanged. Static validation and four independent review lenses
  passed; no hosted checks are configured in this caller repository.
- [Runner reservation #6](https://github.com/tkstang/actions-runner/pull/6),
  head `1eaf9d7b35fb9528fcfcfc19e2b48a61b1068bb0`, stacked on existing runner #4:
  seventh guest identity, separate uninstalled
  one-slot profile, empty exact job list and independent refusal of fleet starts
  in the observer, root helper and JIT wrapper. Guest qualification inventories
  include the new identity. Exact nested jobs remain unqualified. Existing
  pilot/configuration/installer and installed host state are unchanged. Unit and
  source checks passed; all four review lenses are covered, including independent
  confirmation of a case-alias observer fix. Initial full suite passed 149 tests;
  the added case-alias regression passed with all 16 GitHub-boundary tests. No
  hosted checks are configured. An older guest needs
  an approved upgrade before the new seven-identity status proof can pass.

The [runner packet](runner-proxy-readiness.md) records admission, qualification
and release gates. Disabled repository entries still expand observation and
must be included in credential/receipt review; do not install the new profile
under the personal-skills-only scope. External merges, credentials, host
activation and workflow dispatch have not been approved or performed.

The operator selected isolated transport for full support in the
[fleet confidentiality proposal](fleet-confidentiality-design.md). The
[durable design and delivery plan](../../../reference/research/fleet-artifact-transport.md)
propose an external scoped key-release service and exact-job grants, keeping
shared decryption authority outside executable PR/setup jobs. Platform binding,
service packaging/custody and live qualification remain unresolved gates.
No encryption key or transport has been introduced.

Target tokens, target selection and privileged host admission remain user-owned.
Source-secret deletion requires the caller merge, explicit approval and a fresh
no-reader check. Release publication is separately gated; no tag or release
exists. New production routes, runner/JIT lifecycle and model-backed acceptance
remain unqualified. No paid fallback or live model call ran in this preparation.

Goal remains active and incomplete. Remaining scope is live Sol adjudication,
approved runner/caller integration and live pool evidence, versioned delivery,
artifact encryption and final integrated acceptance.

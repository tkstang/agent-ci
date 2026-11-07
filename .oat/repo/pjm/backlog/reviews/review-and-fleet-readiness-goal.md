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
  artifact transport for full support. On 2026-10-31 the operator preauthorized
  the discussed external merges, runner setup/activation and bounded qualification,
  release publication, and deletion of secrets proved unnecessary. Technical
  readiness, credential boundaries and preservation of other sessions still apply.
- **Remaining boundaries:** no force-push or branch deletion; target PAT creation
  remains user-owned. Broker hosting/key custody is undecided and not provisioned.
  Do not replay consumed privileged launchers, bypass qualification, or overwrite
  another session's runner work under the new setup authorization.
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

External integration history and current status:

- [Private-fleet caller #5](https://github.com/tkstang/agent-ci-private-fleet/pull/5),
  merged as `fb62cc50ae1e2dbc08cded6bb8c73aba6be3229b` after the independently
  reviewed release-pin delta `e08126f1aab7f852253f56e61947bf8a0697f538`: pins
  `v0.1.0`, removes the source-token mapping, requires dedicated labels,
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
under the personal-skills-only scope. The operator subsequently approved the discussed merges, runner setup and
bounded qualification. The private-fleet migration subsequently merged. No runner/fleet activation or
model dispatch ran here.
Runner #5 contains later runtime corrections and uncommitted upgrade work in a
separate checkout; reconcile that source before integrating #6 or upgrading.

The operator selected isolated transport for full support in the
[fleet confidentiality proposal](fleet-confidentiality-design.md). The
[durable design and delivery plan](../../../reference/research/fleet-artifact-transport.md)
propose an external scoped key-release service and exact-job grants, keeping
shared decryption authority outside executable PR/setup jobs. Platform binding,
service packaging/custody and live qualification remain unresolved gates.
No encryption key or transport has been introduced.

The operator selected a private pilot; its identity stays in private caller
records. Target PATs remain user-created. Source-secret deletion completed after migration and a fresh no-reader/
active-run check, including the stale manual branch. Release `v0.1.0` is published at
`50d8e809eb843c164988ff0cdc076d14aa604174`; consumer pin updates are being prepared. New production routes, runner/JIT lifecycle and model-backed acceptance
remain unqualified. No paid fallback or live model call ran in this preparation.

Goal remains active and incomplete. Remaining scope is live Sol adjudication,
approved runner/caller integration and live pool evidence, versioned consumer pins,
artifact encryption and final integrated acceptance.

## 2026-10-31 setup reconciliation

Design PR #8 merged as `5673eeb31339b91ac4d1574b6e2e589a58acf13f`.
Read-only host checks confirm the reviewed boot is unchanged, installed runner
source is `4e72f1ddb41a07e68af40d2071cc7962fa014950`, and the activation receipt
and watcher plist are absent. Later retained recovery/JIT success records exist;
the old launchers are consumed and must not be replayed. This does not qualify
the agent-ci fleet or close runner lifecycle acceptance. Runner #5 is a separate
draft lane with runtime corrections and uncommitted upgrade edits; #4/#6 alone
are not a coherent current production upgrade target. No privileged mutation ran.

## 2026-10-31 source-secret retirement

Private-fleet #5 merged as `fb62cc5`; the obsolete manual branch received only
the exact reviewed disabled workflow in ordinary commit `a32f1ed`, preserving
its other files and history. All three remote branch tips were scanned for
workflow/script readers: zero source-token readers, zero tags. Five active-run
status queries returned zero. The source release/public visibility was rechecked
immediately before deleting `AGENT_CI_SOURCE_TOKEN`; a fresh secret-name listing
confirmed absence. Proxy and model secrets were retained. Historical workflow
reruns still refer to retired definitions/source history and are not a supported
migration path. No runner, fleet admission variable or model job was activated.

## 2026-11-03 continuation

The operator requested continued execution under the existing boundaries.
Runner #4/#5/#6 are merged; #6 landed as `587f79e` after 243 full-suite and
50 applicable Apple-Python tests. The runner owner subsequently reports a
simplified installed controller with VM-config and personal-skills-only token
scope guards, working wake-on-demand and measured idle shutdown. These are
personal-skills operating results, not agent-ci fleet or model-route acceptance.
The old frozen-source instructions are historical; the owner retains current
host, credential and deployment operations. The owner's current handoff confirms
the dormant fleet guards remain in source. Admission needs exact current caller
job identities, reviewed guard removal/list matching, and coordinated token plus
configuration changes: the startup scope check requires exact set equality.
Changing only token scope or only configuration interrupts the working pilot.
The seventh guest account/bootstrap path remains unverified, and no maintenance
window or credential mutation is performed by this preparation.

Both target secret names are present and the retired source secret is absent
at the read-only metadata check. Live access remains unverified. Preparation
continues with the [synthetic artifact identity packet](../../../../../docs/artifact-conformance.md)
and its manual-only workflows, without live dispatch or service provisioning.
The candidate remains disabled pending signature verification, actual nested
claims/attempt-specific Jobs evidence and complete-graph uniqueness proof.
Packaging, hosting and key custody are still unresolved. No completion or
encryption claim is made.

## 2026-11-04 conformance execution and runner coordination

The operator approved squash-merging [PR #12](https://github.com/tkstang/agent-ci/pull/12)
and up to three synthetic attempts totaling at most 22 capture jobs. The merge
is `7f94ad35d3100e5a4bd0e9779b061fe936e65290`; its tree is identical to reviewed
head `3f56021e3fd20f8cbdc577ac8ae5b62539033c26`. Hosted verify/actionlint passed;
the three label-gated self-tests were intentionally skipped. GitHub rejected a
direct-SHA dispatch without creating a run, so an SSH push created the dedicated
`probe/artifact-conformance-7f94ad3` branch at the approved merged commit.

The optional-off [run 41902471583, attempt 1](https://github.com/tkstang/agent-ci/actions/runs/41902471583/attempts/1)
executed six captures. Optional-on [run 41902498611, attempt 1](https://github.com/tkstang/agent-ci/actions/runs/41902498611/attempts/1)
and its [complete rerun, attempt 2](https://github.com/tkstang/agent-ci/actions/runs/41902498611/attempts/2)
executed eight captures each. Every caller and reusable revision matched the
approved merged source. All 22 captures returned `E_INVALID_INPUT` before the
OIDC request; zero artifacts were uploaded. Complete attempt-specific Jobs
records, canonical check-run URL mappings and fixed error envelopes were saved
privately. There are no claim reports to reconcile, and the existing grouped
error cannot identify the exact rejected input. This is failed platform
qualification, not evidence that a required claim is absent or a reason to
weaken a refusal. The approved run budget is exhausted.

The authorized follow-up prepares a reviewed diagnostic patch and focused tests
for closed preflight refusal reasons without values, actual lengths, destinations
or exception text. Existing validation and confidentiality boundaries remain.
The patch's merge and any further bounded live probes require new approval.
Signature verification, subject qualification, attempt-specific claim/Jobs
binding and complete pinned-graph uniqueness proof remain open before key
release. No broker or encryption implementation is accepted by this result.

The runner owner reports synchronized token-scope and dormant fleet-config
updates, successful deployment/startup checks and a healthy watcher. The fleet
entry stays disabled with an empty exact job list, `workflow_dispatch` only,
and one slot shared with the existing pilot. Runner PR #10 merged as `4c0f083`;
installed runtime remains `118a8b2`, with the installer change pending the next
owner-managed upgrade. These reported updates supersede the token/configuration
dependency in the November 3 record; the owner says neither needs another
change for the remaining admission sequence.

Remaining runner work is separate: qualify exact expanded production job names
against current caller/reusable revisions, review list matching and removal of
the four dormant refusal boundaries, then let the owner drain/upgrade/reload
and verify the fleet guest account and unit before one approved manual dispatch.
Whether upgrade reruns guest bootstrap is still unverified. Host, service and
credential operations remain with the owner; no such mutation is authorized by
this informational update. The delivery goal and both open backlog items remain
incomplete.

## 2026-11-06 request-credential bound follow-up

Diagnostic [PR #13](https://github.com/tkstang/agent-ci/pull/13) merged as
`c3d87280dc418ef7894b16f6ff058f023d58dc6a`. The approved optional-off
[run 42279537227, attempt 1](https://github.com/tkstang/agent-ci/actions/runs/42279537227/attempts/1)
used that caller/reusable revision and exhausted its one-attempt, six-capture
allowance. Every capture refused before HTTP with `E_INVALID_INPUT` and
`request_credential_too_long`; zero artifacts were uploaded. The observed
credential exceeded the former 4,096-character cap without exposing its value or
actual length. This does not determine the exact cause of the earlier 22 failures
or establish any OIDC claim qualification.

The next narrow fix sets an independent 16,384-JavaScript-string-character
request-credential cap, retaining a finite local bound with headroom. This is
not a documented GitHub maximum or a compatibility guarantee. Request URL,
response-body and returned-JWT limits, destination restrictions and secret
suppression remain unchanged. The operator separately approved this fix's merge
after independent review and hosted CI, followed by exactly one optional-off
probe of at most six capture jobs, inspection and stop. This is a new bounded
allowance; it does not renew the exhausted earlier probes or authorize reruns.
No live run of this source, host operation or credential mutation has occurred.
The remaining identity, artifact-encryption and integrated-acceptance gates stay
open.


## 2026-11-07 authenticated conformance preparation

Request-bound [PR #14](https://github.com/tkstang/agent-ci/pull/14) merged as
`f8de84e84cc9c182f30ac3ca5fb223a33d128c7b` after independent review and hosted
verify/actionlint; the three label-gated self-tests were skipped. Its approved
optional-off [run 42293959035, attempt 1](https://github.com/tkstang/agent-ci/actions/runs/42293959035/attempts/1)
yielded six reports. Separately approved optional-on
[run 42296000371, attempt 1](https://github.com/tkstang/agent-ci/actions/runs/42296000371/attempts/1)
and its [complete rerun, attempt 2](https://github.com/tkstang/agent-ci/actions/runs/42296000371/attempts/2)
yielded eight reports each. Caller/reusable source matched the merged revision.
Every report mapped one-to-one to an attempt-specific canonical check-run URL;
the rerun preserved names/selectors/source with zero shared job/check-run IDs.
Evidence remains in private local staging. These are version-1 decode-only
observations, not authenticated identity or production qualification. Both
bounded allowances are exhausted; no further probe is approved.

The authorized next packet prepares RS256 signature, exact immutable-ID branch
subject and time verification before any report/selector persistence, plus a
commit-pinned complete-graph proof for the three synthetic workflows. Read-only
repository OIDC settings confirmed the immutable subject policy. The constrained
recognizer enumerates all eight assignments, including optional jobs, and binds
source digests; it never qualifies a production graph or releases keys. See the
[conformance runbook](../../../../../docs/artifact-conformance.md) for bounds and the proof command. This packet's merge and any live
acceptance need new approval. No broker, key, deployment, host/service operation,
credential mutation or production admission is performed. Packaging, hosting,
key custody, production assignment proof, encryption and integrated acceptance
remain open; the delivery goal and both remaining backlog items are incomplete.

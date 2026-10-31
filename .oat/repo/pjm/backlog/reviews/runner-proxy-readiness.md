# Runner and proxy qualification packet

Prepared 2026-10-31 for **BL-261025-self-hosted-runner-and-proxy — Self-hosted runner and proxy readiness**.
Original packet: external draft PR preparation only. On 2026-10-31 the
operator subsequently preauthorized the discussed merges, runner setup and
bounded qualification, release publication and deletion of unnecessary secrets.
The technical gates below still apply; target PAT creation remains user-owned.

## Source snapshot before external draft preparation

- `tkstang/actions-runner/main` is `038294cf15dcba9b11ffc8c19d9614a368a8c5df`.
  [PR #4](https://github.com/tkstang/actions-runner/pull/4) is open at
  `3712ab5e06405ecde482abb1549db646c823fae1`. Source review does not prove
  installed state or completed host acceptance.
- At the read-only 2026-10-31 check, the private fleet listed zero runners.
  JIT runners may be absent while idle; this count alone cannot establish
  whether its controller is installed or healthy.
- `actions_runner/config.py:13–20,63–77` admits six fixed repositories,
  excluding the private fleet, and requires `.github/workflows/ci.yml` and
  one fixed job name per repository.
- `actions_runner/github.py:184–225` requires all four routing labels
  (`self-hosted`, `linux`, `arm64`, repository label), an exact job name,
  exact caller workflow path and same-repository head. Its event allowlist
  includes push, pull_request and workflow_dispatch, not schedule.
- The reusable agent-ci workflows previously accepted only one runner label.
  This delivery adds JSON label arrays while keeping existing label strings
  and hosted defaults. Nested calls forward the original string unchanged.
- Release `v0.1.0` now exists at `50d8e809eb843c164988ff0cdc076d14aa604174`.
  The private fleet's previous source pin
  belongs to the retired history; its caller migration is now prepared in the approved draft below.

## Approved draft preparation and remaining admission

The prepared [runner draft #6](https://github.com/tkstang/actions-runner/pull/6)
stacks on runner #4 and reserves only the private fleet,
with a dedicated guest identity and label, exact caller workflow paths,
an empty nested-job allowlist, and a manual-dispatch-only future policy.
It is deliberately dormant: configuration, observer, root guest helper and JIT
wrapper refuse new fleet starts. Determine actual expanded nested job names
with a safe current-source probe before a later reviewed allowlist change. Do not widen it to arbitrary repository,
workflow, job or event wildcards. Keep one global job slot for the pilot.
Scheduled fleet admission requires its own explicit event-policy review after
manual acceptance, including queueing, cancellation and cleanup evidence.

The runner's listener can take other matching jobs in its repository after
registration. Review every workflow capable of using the admitted labels,
not just the job that caused the controller to create the listener.

The [private-fleet caller #5](https://github.com/tkstang/agent-ci-private-fleet/pull/5)
merged as `fb62cc50ae1e2dbc08cded6bb8c73aba6be3229b`, pins `v0.1.0` at
`50d8e809eb843c164988ff0cdc076d14aa604174`, and removes the source-token input.
It preserves target membership and the DeepSeek maintenance default, requires
the dedicated labels and private output, and remains manual-only/disabled behind
`AGENT_CI_FLEET_ADMITTED`. The source secret was deleted after the fresh reader/
active-run checks recorded below. This completed migration does not qualify or
activate the fleet, add the selected pilot, or create its target PATs.

## Ordered acceptance

1. Reconcile the reported completed recovery/JIT evidence with installed source
   and the remaining lifecycle gates. Preserve pinned evidence and never replay
   the consumed launchers. Reconcile the separate runner #5 corrections and
   unfinished upgrade work before choosing a combined production source.
2. Review the dormant reservation and subsequent exact-job admission change.
   The operator preauthorized the discussed merges and host setup/activation.
   Reconcile current source, the exact continuation and credential scope first.
3. From the admitted guest identity, verify Node 24, pnpm 11 and the pinned
   agent harnesses on Linux ARM64. Qualify the frozen helper install/build
   and `agent-ci harness smoke --harness codex`. Any image/user-namespace
   changes are runner-provisioning work, not job-time privileged actions.
4. Verify proxy transport and authentication from that exact guest network
   namespace. The host's loopback is not the guest's loopback. Inject the
   canonical HTTPS origin from `AGENT_CI_PROXY_BASE_URL` and the existing
   pool key without printing either. A transport response alone does not
   prove authentication or selected-model availability.
5. Run one manual, read-only, non-publishing job on a trusted target with
   a pool model, explicit `allow_pool` and all admitted runner labels.
   Record exact source/caller revisions, GitHub run URL, route/model/effort,
   harness versions, runner identity, result status, duration, cancellation
   cleanup and JIT deregistration. Keep private target names and raw model
   output out of public evidence. No paid fallback is permitted.
6. Qualify Sol High and requested Opus High independently before marking
   their routes qualified. Sol Low adjudication additionally needs the
   approved direct tool-free Responses implementation
   (merged [PR #7](https://github.com/tkstang/agent-ci/pull/7)) and its own live proof. Keep the generic
   primary-only default; the operator's reviewer-plus-adjudicator preference
   is not fulfilled until that path works.

## Versioned delivery

Release `v0.1.0` is published at
`50d8e809eb843c164988ff0cdc076d14aa604174`, with the live/transport limits
stated in its notes. The private-fleet migration already uses that version;
this change updates the public consumer templates too. Helpers resolve from
the workflow's own commit. Preserve the recorded tag-to-commit mapping for
review and rollback; publication does not imply live qualification.

## Release notes for v0.1.0

Published at `50d8e809eb843c164988ff0cdc076d14aa604174` after the operator
authorized publication. The source revision has passing hosted verify/actionlint.
The live and artifact limitations below remain true.

- Sol 6.1 High primary review, optional Opus 5.5 High, and Sol 6.1 Low
  adjudicator configuration. Generic defaults run the primary only.
- Claude Code subscription-pool CI support with self-hosted execution and
  explicit pool opt-in; no paid fallback.
- JSON runner-label arrays across reusable workflows.
- Stronger Claude-only/automatic-router policy guards and per-pass credential
  isolation, plus original Git-context pinning during local review.
- Merged file/JSON target lists and private-output suppression. Artifacts are
  still plaintext and Actions metadata can identify targets.
- Direct tool-free Sol Low adjudication through the existing subscription pool
  merged as `50d8e809eb843c164988ff0cdc076d14aa604174` in #7. It bypasses CLI
  installation, sends no tools and rejects leaked credentials across the full
  response envelope. Live proxy compatibility remains unqualified.

Validation records must distinguish local/hosted source checks from live runner,
selected-model and JIT lifecycle proof. New production routes and the dedicated
fleet runner remain unqualified; full artifact encryption is not implemented
and caller activation remains gated.
The release notes must carry these limits while they remain true.

## Remaining acceptance

Proxy-origin override and label-array integration are merged.
A coherent reviewed runner upgrade, exact-job admission, compatibility,
activation and live pool/lifecycle acceptance remain outstanding. Source release
publication, private-caller migration and retired source-secret deletion are
complete. This backlog item stays open.

## Later reconciliation: preserve current runner work

The old recovery/JIT launchers have been consumed; retained records report
success. Root read-only checks confirmed the reviewed boot, installed source
`4e72f1ddb41a07e68af40d2071cc7962fa014950`, and absent activation receipt/
watcher plist. This is not fleet activation or full lifecycle acceptance.
Runner PR #5 is a separate draft atop #4 and contains later runtime/JIT fixes;
its owned checkout also has uncommitted upgrade edits. #6 diverges from that lane.
Do not install #4/#6 as a replacement for the newer installed source or touch
that other session's edits. Reconcile the combined reviewed source and current
non-sudo production CI compatibility before preparing any new privileged tuple.

Release `v0.1.0` has been published at `50d8e80` with explicit unqualified-route
and plaintext-artifact limits. Keep fleet admission disabled until its
remaining technical gates pass.

Private-fleet migration #5 is now merged as `fb62cc5`, pinned to `v0.1.0` and
still disabled. The stale manual branch now has the same reviewed disabled
workflow. A fresh all-branch workflow/script reader scan and five active-run
status checks passed before the approved source-token deletion; absence was
verified afterward. Model/proxy credentials were preserved. No activation or
new model qualification is claimed.

# Runner and proxy qualification packet

Prepared 2026-10-31 for **BL-261025-self-hosted-runner-and-proxy — Self-hosted runner and proxy readiness**.
External draft PR preparation is approved. This packet does not authorize
external merges, activation, credentials, dispatch or release publication.

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
- No release tag currently exists. The private fleet's previous source pin
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

The [private-fleet caller draft #5](https://github.com/tkstang/agent-ci-private-fleet/pull/5)
replaces the unavailable source pin with merged source
`2c9c777dc8d2f54185f46eb8b46baaf741fe21c2`, removes the retired source-token
input, requires the complete dedicated label array and `allow_pool`, and maps
explicit route credentials. It preserves target membership and the maintenance
DeepSeek default, serializes presets, sets private output and stays disabled
behind `AGENT_CI_FLEET_ADMITTED`. A released version will replace the interim
full SHA only after separate release approval and publication. Do not delete the
source secret until the migration merges and a fresh no-reader check passes.
No new credential, secret deletion or target-repository selection is included.

## Ordered acceptance

1. Complete the existing runner pilot's reviewed recovery, fresh proof,
   source upgrade, guest qualification and JIT lifecycle acceptance. Preserve
   its pinned recovery evidence. Do not substitute a generic privileged rerun.
2. Review the dormant reservation and subsequent exact-job admission change.
   External merges need separate approval, followed by separate permission for
   host installation/activation and credential scope.
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

After the approved source PRs merge, prepare `v0.1.0` at the exact merged
source revision, with release notes covering new review defaults, Claude pool
support, label-array routing and the outstanding live/transport limits. Do not
publish an absent tag in working caller references. Tag/release publication remains separately gated. Caller edits are a prepared
draft only; no external merge or activation has run here.

Use a released version in consumer templates and migration PRs once the tag
exists; helpers resolve from that workflow's own commit. Record the tag's
commit and validation result so the operator can audit or roll back the pin.
A release must not imply live qualification that has not occurred.

## Draft release notes for v0.1.0

Not published. Select and record the final merged source commit after review
of the direct Sol Low transport; do not create a tag from an open PR or update
consumers to a version that does not exist.

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
Runner admission, approved activation, the first live job and a published
release remain outstanding. This backlog item stays open.

# Runner and proxy qualification packet

Prepared 2026-10-31 for **BL-261025-self-hosted-runner-and-proxy — Self-hosted runner and proxy readiness**.
This is an integration proposal and evidence checklist, not permission to activate
services, change credentials or mutate another repository.

## Verified source and GitHub state

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
  belongs to the retired history; its caller migration remains separately
  authorized work.

## Proposed admission change for separate approval

Prepare a PR in `tkstang/actions-runner` to admit only the private fleet,
with a dedicated guest identity and label, exact caller workflow paths,
explicit nested job identities, and manual-dispatch-only initial acceptance.
Determine the actual expanded nested job names with a credential-free hosted
probe before finalizing the allowlist. Do not widen it to arbitrary repository,
workflow, job or event wildcards. Keep one global job slot for the pilot.
Scheduled fleet admission requires its own explicit event-policy review after
manual acceptance, including queueing, cancellation and cleanup evidence.

The runner's listener can take other matching jobs in its repository after
registration. Review every workflow capable of using the admitted labels,
not just the job that caused the controller to create the listener.

The caller migration in the private fleet is a separate PR proposal: replace
its unavailable agent-ci pin with an approved release, remove the retired
source-token input, set the complete admitted label array and `allow_pool`,
and map only the selected subscription-pool credential. Do not delete the
source secret until the migration merges and a fresh no-reader check passes.
No new credential, secret deletion or target-repository selection is included.

## Ordered acceptance

1. Complete the existing runner pilot's reviewed recovery, fresh proof,
   source upgrade, guest qualification and JIT lifecycle acceptance. Preserve
   its pinned recovery evidence. Do not substitute a generic privileged rerun.
2. Review and merge the narrowly scoped fleet admission change, then obtain
   separate permission for host installation/activation and credential scope.
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
   pending tool-free transport decision and its own proof. Keep the generic
   primary-only default; the operator's reviewer-plus-adjudicator preference
   is not fulfilled until that path works.

## Versioned delivery

After the approved source PRs merge, prepare `v0.1.0` at the exact merged
source revision, with release notes covering new review defaults, Claude pool
support, label-array routing and the outstanding live/transport limits. Do not
publish an absent tag in working caller references. Tag/release publication
and private-fleet edits remain separately gated; neither has run here.

Use a released version in consumer templates and migration PRs once the tag
exists; helpers resolve from that workflow's own commit. Record the tag's
commit and validation result so the operator can audit or roll back the pin.
A release must not imply live qualification that has not occurred.

## Remaining acceptance

Proxy-origin override is implemented. Label-array integration is prepared.
Runner admission, approved activation, the first live job and a published
release remain outstanding. This backlog item stays open.

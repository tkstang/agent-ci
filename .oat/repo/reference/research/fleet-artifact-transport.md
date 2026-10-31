# Fleet artifact transport

**Status:** proposed design, 2026-10-31. The operator selected isolated transport
for full support. No broker, encryption, key, deployment or live qualification
exists. Reviewed source baseline: `50d8e809eb843c164988ff0cdc076d14aa604174`.

Supports **BL-261025-fleet-repositories-merged — Fleet repositories: merged target
lists and protected artifacts**. Operational status and authorization remain in
the [delivery goal](../../pjm/backlog/reviews/review-and-fleet-readiness-goal.md).

## Contents

- [Contract](#contract)
- [Service boundary](#service-boundary)
- [Job authorization](#job-authorization)
- [Artifact protocol](#artifact-protocol)
- [Workflow coverage](#workflow-coverage)
- [Lifecycle and failures](#lifecycle-and-failures)
- [Delivery and acceptance](#delivery-and-acceptance)
- [Evidence](#evidence)

## Contract

Every maintained upload path, including failure diagnostics, becomes ciphertext
when transport is enabled. Every maintained download authenticates and decrypts
its assigned input before existing domain validation. Encryption remains optional
under caller policy; required encryption never falls back to plaintext.

A job executing PR/setup code can read its own assigned plaintext and keys. It
cannot obtain another target's keys, a fleet private key, grant-administration
authority, or the broker's GitHub credential. Existing model and target-write
credential boundaries remain separate. Verification with `allow_pool` remains
refused; this design does not change that policy.

This protects stored artifact contents, not anonymity or deliberate exfiltration
by code already permitted to read those contents. PR code can use its Actions
runtime token to upload additional artifacts. Covering arbitrary hostile uploads
would require a different runtime authority boundary. GitHub job/matrix/checkout
metadata remains visible. Envelope headers also expose opaque identifiers,
artifact kind, sizes and digests; never put repository names, paths, logs,
credentials or proxy origins in them. Immutable repository IDs can still be
correlated with public repositories. Public digests can reveal equality.

## Service boundary

Propose one external HTTPS broker independent of Actions runner slots. It owns
the unwrap private key, immutable grant/artifact registry, policy and narrowly
scoped GitHub Actions-read access. Public GitHub-hosted and private self-hosted
consumers use the same protocol. No broker process shares a consumer's runner,
guest, filesystem, user or credential store.

A protected host-only service would not cover GitHub-hosted consumers. A
concurrent Actions broker can deadlock the proposed private fleet's one-global-
slot runner admission. Matrix `max_parallel` and runner global capacity are
different controls; the former defaults to four, not one.

Broker deployment, hosting owner, credential provisioning, TLS identity, key
custody/backups and operational support are unresolved provisioning decisions.
The endpoint is trusted administrator configuration; reject artifact-supplied
endpoints/keys, redirects and unrestricted network destinations. Never reuse the
model proxy credential, endpoint or paid API configuration for this service.

The service is a second deployable and triggers reconsideration of
[DR-261025-keep-agent-ci-a-single-package — Keep agent-ci a single package](../decisions/DR-261025-keep-agent-ci-a-single-package.md).
Before service implementation, record the reviewed packaging/deployment decision
through OAT. Candidate: retain one TypeScript package and shared schemas, with a
separate broker entrypoint/deployment; isolate its private-key configuration from
the CLI. A monorepo or second repository is not implied or authorized.

## Job authorization

### Platform evidence and remaining condition

GitHub documents signed `check_run_id` as the current job's check-run ID, and its
live OIDC discovery advertises it. This corrects the earlier feasibility note's
uncertainty about whether any per-job identity exists. No actual nested-job token
has been minted in this investigation.

Recommended candidate: signed check-run identity reconciled against broker-owned
Jobs REST data and a pre-registered, pinned workflow graph. Exact job names are
mapping metadata, not an independently documented security principal. This
candidate **must remain disabled until the conformance gates below pass**. Do
not implement a permissive run-wide fallback if they fail.

### Trusted assignment issuer

Add a separately pinned reusable grant-issuer workflow, with no PR checkout,
setup commands, untrusted executable hooks or model/target-write credentials.
Authenticate its actual leaf workflow identity, approved caller identity and
expected event before allowing manifest registration. Calling a shared inner
job can change the leaf identity; qualify the actual claims rather than assuming
the wrapper filename survives.

The issuer constructs assignments from validated caller configuration and the
entire approved workflow graph. It resolves immutable target repository IDs and
commit SHAs, applies owner/routing limits, allocates unique opaque invocation
scopes and registers the manifest before any key release. It has no unwrap key
and cannot grant arbitrary repositories outside administrator policy.

Each assignment contains:

- Immutable caller repository/owner IDs, run ID and run attempt; approved caller
  workflow SHA and complete nested reusable-workflow pins.
- Unique invocation scope, role, target repository ID and target commit; expected
  leaf workflow identity and exact full Jobs REST name.
- Permitted output slots/kinds and directed input edges to specific producer
  slots; policy version and expiry. Concrete artifact IDs/digests fill those
  edges only through authenticated registration.

The broker independently validates manifest cardinality, allowed role edges,
scope uniqueness and approved graph version. It must not trust an issuer's
arbitrary graph, claimed target or added edge. Caller configuration and graph
pins are administrative trust, not user-selectable OIDC audience text.

### Consumer identity reconciliation

For every registration or key request:

1. Verify GitHub's JWT signature using configured issuer/JWKS, an explicit
   algorithm allowlist, broker audience, validity times and bounded clock skew.
   Require immutable repository/owner IDs, run/attempt, signed `check_run_id`,
   caller workflow identity and approved leaf workflow ref/SHA. Validate the
   configured subject format too; do not assume all repositories use the legacy
   name-based `sub`. Unknown/missing claims fail closed. Bound JWKS caching and
   refresh on a new key ID; network failure confers no authority.
2. Fetch all pages of the authenticated Jobs REST **run-attempt endpoint** using
   the broker's own credential. Match signed `check_run_id` to the numeric ID in
   a validated canonical `check_run_url` for this repository. Do not assume the
   Jobs REST `id` equals that ID. Validate run, attempt and commit consistency;
   truncated, ambiguous or inconsistent metadata is a refusal.
3. Map the resulting exact name and pinned leaf workflow to exactly one manifest
   assignment. Bind the complete caller/run/attempt/check-run tuple permanently
   to that assignment. Requests supply only selectors; their target, role,
   artifact ID or audience cannot enlarge this assignment.
4. Resolve the requested input through that assignment's registered edge. Verify
   artifact identity, envelope context/digests, policy, expiry, run state and
   revocation before releasing only its data key. No generic unwrap endpoint.

All arbitrary code inside a job with `id-token: write` can request that job's
OIDC tokens; an earlier/later trusted step does not change this authority.
Grant registration is restricted to the dedicated issuer. Consumer registration
is limited to its own declared output slots, never grant creation.

### Uniqueness before release

The approved caller and every nested workflow must make the assignment mapping
injective across the **complete** possible graph: target invocations, matrices,
primary/second passes, optional paths and retries. Expected full names come from
the trusted graph, not consumer-submitted strings. Pin every workflow revision;
refuse unrecognized caller shapes, duplicate scopes, duplicate logical slots or
name aliases. No late dynamic expansion may introduce another job for a granted
assignment. The issuer and broker must prove these constraints before release.

An incomplete current Jobs REST listing is not proof of uniqueness. Never bind
the first match and reject later duplicates: disclosure cannot be undone. Static
graph proof must cover future jobs, and live qualification must establish stable
names/claims and that consumer code cannot mutate another assignment's mapping.
If this cannot be proved, replace this candidate before enabling encryption.

Alternatives for a failed proof are administrator-predeclared signed Environment
scopes or independently attested concrete check-run grants. Neither is a silent
fallback. Environments need an administrator-owned exact scope-to-role/target
map, approved leaf/caller pins and run manifest, denial of unknown/auto-created
environments, plan/branch/event compatibility and separate configuration. A
consumer naming an environment or a job is never sufficient on its own.

## Artifact protocol

### Encryption envelope

Propose Node 24 stdlib RSA-3072 OAEP-SHA256 wrapping a fresh random AES-256-GCM
key for each artifact. Keep the public SPKI fingerprint/key ID in reviewed trust
configuration. No crypto dependency or actual key is required for this design.

Binary envelope, with strict length checks and no trailing bytes:

```text
"AGCIENC1" || u32be(contextLength) || context || nonce[12] ||
wrappedKey[384] || ciphertext[plaintextLength] || tag[16]
```

Context is fixed-order canonical UTF-8 JSON, at most 16 KiB. Reject noncanonical
encoding, duplicate/unknown fields, noncanonical decimal ID/count strings,
unsupported algorithms, truncation and overflow. Proposed absolute payload cap
is 16 GiB, with lower per-kind, disk and GitHub quota limits enforced before
packing/streaming. Final values require measured sizing; do not allocate the
whole artifact in memory. The manifest also bounds artifact/assignment counts,
request bodies, archive expansion, concurrent operations and total bytes.

Context binds protocol/algorithm/key ID, random 128-bit transport UUID,
caller repository/owner IDs, run/attempt, invocation scope, target repository
ID/commit, artifact kind, producer role, consumer-policy version, whole plaintext
SHA256/length and release deadline. It cannot include the GitHub artifact ID,
which is assigned only after upload. Preserve existing domain/directory digests
separately; they do not necessarily hash the packed transport bytes.

Let `P` be all envelope bytes through the nonce:

```text
wrappedKey = RSA-OAEP-SHA256(publicKey,
  "AGCIKEY1" || dataKey[32] || SHA256(P),
  label = "agent-ci/artifact-envelope/v1")

ciphertext, tag = AES-256-GCM(dataKey, nonce, packedPlaintext,
  AAD = P || wrappedKey)
```

Set OAEP and MGF1 to SHA256 explicitly; Node's default OAEP hash is SHA1. Before
releasing a data key the broker must decrypt the wrapper, verify its exact
prefix/length and compare the embedded `SHA256(P)` in constant time. GCM AAD
alone does not stop a transplanted wrapper from being presented to a broker
with a new authorization header. Bind the wrapper to its original context at
the broker before release. Use uniform failures to avoid a padding oracle.

### Upload and registration

The producer encrypts to a private staging file and uploads a single envelope
using the pinned artifact action. It then authenticates as its assigned job and
registers its declared output slot. The broker retrieves the immutable artifact
with its own GitHub authority, verifies its repository/run association and
bounded single-envelope archive structure, and streams the ciphertext digest.
It checks the header against the producer's assignment before storing:

```text
artifact ID -> transport UUID, output slot, header hash, envelope SHA256,
               plaintext SHA256/length, producer identity,
               caller/run/attempt/scope/target/policy/expiry
```

The registry freezes both UUID and logical output slot. Identical retries are
idempotent; any changed binding is refused. A downstream edge resolves only
this record, never an artifact ID asserted by a consumer or a mutable artifact
name. Deleted/replaced artifacts require a new full run attempt, not rebinding.
GitHub upload/download archive packaging is separate from the envelope digest;
hash the exact envelope bytes, not the action's outer archive representation.

Public-key encryption proves no producer provenance: anyone can construct an
envelope. Authenticated producer registration, trusted assignments and
broker-side artifact retrieval provide that binding. A compromised producer may
fabricate its own outputs; existing spec/result/domain checks still apply.
It cannot register a header/wrapper for another target, role or output slot.
Orphaned unregistered uploads never become inputs.

### Download and bootstrap

The consumer downloads by registered artifact ID, verifies envelope SHA256 and
context, authenticates to the broker and receives only its assigned data key
over TLS. Responses and keys never enter stdout, command arguments, summaries,
artifacts or HTTP access logs. No caching across jobs. Bound in-memory lifetime;
best-effort buffer clearing does not claim complete JavaScript memory erasure.

Decrypt to private staging, with mode 0700 directories and 0600 files. Do not
publish any `decipher.update()` output until `final()` authenticates the tag and
the exact whole plaintext length/SHA256 passes. Then atomically publish the
packed bytes and invoke existing archive/path/domain validators. Reject symlink,
path traversal and archive expansion attacks before restoring to a workspace.
Delete staging on error/cancel; require a fresh/discarded runner per job. File
modes cannot isolate hostile processes sharing the job's UID.

Bootstrap must exist **before** decrypting the built helper bundle. Use a
separately pinned minimal trusted action/bootstrap available from the approved
agent-ci revision, with its own reviewed build/distribution path. It must not
come from PR checkout or an arbitrary helper `agent_ci_ref`. The broker's policy
refuses unknown bootstrap/workflow pins. Resolve how the trusted bootstrap is
distributed without publication before wiring the workflow; never exempt the
helper artifact or silently trust an override.

## Workflow coverage

Current baseline has nine upload and fifteen download source sites. Repeated
primary/second or matrix invocations increase runtime artifacts, not site count.
Re-enumerate after workflow edits. The same transport covers all rows:

| Kind                         | Producer                  | Consumers                                      | Existing integrity to retain       |
| ---------------------------- | ------------------------- | ---------------------------------------------- | ---------------------------------- |
| Prepared tree                | `run-agent.yml` setup     | `agent-job.yml`                                | packed tree SHA                    |
| Agent result and diagnostics | `agent-job.yml`           | `run-agent.yml` publisher                      | result directory digest            |
| Tools result and diagnostics | `tools-update.yml` runner | its publisher                                  | result directory digest            |
| Review spec and diff         | `pr-review.yml` gate      | verify, primary, second, adjudicator, findings | spec SHA and diff semantics        |
| Built helpers                | `pr-review.yml` gate      | verify                                         | helper tar SHA                     |
| Check evidence               | `pr-review.yml` verify    | review passes                                  | evidence digest and check outcomes |
| Reviewer passes              | `review-pass.yml`         | adjudicator and findings                       | each pass directory digest         |
| Adjudication                 | `review-adjudicate.yml`   | findings                                       | adjudication directory digest      |
| Gated review                 | `pr-review.yml` findings  | publisher                                      | gated digest                       |

Current same-file role identities are insufficient without the exact-job
assignment proof: gate/verify/findings/publisher share `pr-review.yml`,
resolve/setup/publisher share `run-agent.yml`, and tools roles share
`tools-update.yml`. Primary and second share `review-pass.yml`. Repeated targets
can share all of these files. Keep the issuer separate; extract additional role
files only where the reviewed authorization/wiring needs them, rather than
assuming file extraction alone establishes target scope.

Preserve static single-model secret forwarding and target-write isolation.
Preserve `always()` diagnostic uploads, optional failed/missing artifact paths
and trusted publisher error reporting. Failed checks may still produce valid
evidence. A missing intentionally skipped artifact is not a decryption attempt;
an expected artifact that cannot register/decrypt is a transport failure.
Never upload plaintext diagnostics on a broker or encryption failure.

## Lifecycle and failures

- Proposed release expiry: run creation plus 24 hours, additionally bounded by
  policy and artifact retention. Slow/queued jobs may expire; fail explicitly.
  Reruns are separate attempts: v1 requires rerunning the entire graph and never
  implicitly imports earlier-attempt artifacts or grants.
- Before every release, check expiry/revocation and current run cancellation.
  Fail closed when GitHub/broker state cannot be verified. Cancellation and
  revocation prevent subsequent observed releases, not a key already delivered
  or a request racing an as-yet-unobserved cancellation.
- Serialize conflicting registrations/assignment binds transactionally. Restart
  from durable policy/registry state; missing state is refusal. Audit allow/deny
  decisions by opaque IDs, with no JWTs, keys, payloads or private target names.
- Retry only network failures, 429 and transient 5xx within a proposed 30-second
  total request deadline and bounded attempts. Honor bounded Retry-After.
  Do not retry authorization/integrity failures or change identity on retry.
- Public key rotation pins a new key ID in reviewed configuration. Retain old
  private keys only for the approved retention window; revoked/unknown IDs fail.
  Backups need the same custody boundary. Rotation cannot recall released keys.
- Candidate closed result codes: `E_ARTIFACT_CONFIG`, `E_ARTIFACT_FORMAT`,
  `E_ARTIFACT_LIMIT`, `E_ARTIFACT_AUTH`, `E_ARTIFACT_INTEGRITY`,
  `E_ARTIFACT_UNAVAILABLE`, `E_ARTIFACT_CANCELLED`. Review additions to
  `src/result.ts` and CLI handling; preserve machine-readable failure envelopes
  and private-target suppression. Configuration/enabled-but-unavailable never
  means encryption-off. Legacy plaintext requires explicit caller policy.

## Delivery and acceptance

This document does not authorize credentials, service provisioning, GitHub App
installation, workflow dispatch, privileged host work, external merges or
release publication. Local code/PR preparation remains within the active goal.

1. **Review the design.** Independently challenge authorization/provenance,
   envelope context binding, complete workflow/diagnostic coverage and costs.
   Record findings and revise; do not mark fleet encryption complete.
2. **Prepare the conformance harness and packaging decision.** Record the second
   deployable's boundaries through OAT. Prepare synthetic nested/matrix/retry
   workflows and graph fixtures with no real target contents or model/proxy
   access. Obtain separate authorization for actual dispatch and any service/
   credential configuration. Never print a JWT; report only allowlisted claim
   fields required for proof, using synthetic target identities.
3. **Prove the platform binding before enabling the candidate.** Demonstrate
   exact leaf claims and nested names, attempt-specific pagination, optional
   branches, collisions, late duplicates and name-mutation resistance. Prove
   complete-graph injectivity and manifest policy independently of the current
   Jobs REST listing. Failure requires redesign, not relaxing the gate.
4. **Implement protocol and broker in reviewable slices.** First bounded format,
   streaming encrypt/decrypt and strict staging; then OIDC/Jobs verification,
   grant registry, registration/unwrap and lifecycle. Follow repository result,
   alias and test conventions. No real key or endpoint goes in fixtures.
5. **Wire bootstrap and every graph edge.** Add explicit transport policy and
   pinned bootstrap, issuer/slot propagation, all nine/fifteen maintained paths
   and failure diagnostics. Preserve plaintext mode and security constraints.
   Recount source sites and compare runtime edge coverage before handoff.
6. **Validate and independently review implementation.** Use deliberate-testing
   for public boundary tests: wrong target/role/run/attempt/producer; stolen
   wrapper/new header; changed ciphertext/tag/length/digest; duplicate/rebound
   slots; stale/revoked/unknown keys and tokens; partial pagination; broker
   failure/cancellation; unauthenticated staging; helper bootstrap; optional
   artifacts and diagnostic failure. A happy path or shape assertion is not
   security evidence. Run repository gates, workflow structure/actionlint,
   docs/agents, build and gitleaks, then full worktree validation before push.
7. **Separately authorized live acceptance.** Exercise public hosted and private
   fresh-runner graphs, cross-target refusal, failure artifacts, expiry/retry and
   runner destruction. Verify no plaintext maintained upload, no shared unwrap
   authority inside PR/setup jobs, stable pinning and preserved domain digests.
   Prepare caller/release migrations; obtain their own merge/deployment/release
   approvals. Only accepted evidence closes the backlog encryption criterion.

The immediate next deliverable is a reviewed design and conformance packet.
It is not evidence that production encryption or the model routes work live.

## Evidence

Read-only research, 2026-10-31; documentation and discovery are not live workflow
conformance. Sources:

- [GitHub OIDC claims](https://docs.github.com/en/actions/reference/security/oidc#custom-claims-provided-by-github)
- [Live GitHub OIDC discovery](https://token.actions.githubusercontent.com/.well-known/openid-configuration)
- [OIDC in reusable workflows](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-hardening-your-deployments/using-openid-connect-with-reusable-workflows#how-the-token-works-with-reusable-workflows)
- [Attempt-specific Jobs REST](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt)
- [Workflow context availability](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability)
- [GitHub Environment creation](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments#creating-an-environment)
- [Node 24 publicEncrypt](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptopublicencryptkey-buffer)
- [Node 24 authenticated decryption](https://nodejs.org/docs/latest-v24.x/api/crypto.html#deciphersetauthtagbuffer-encoding)
- [Node 24 decipher.update](https://nodejs.org/docs/latest-v24.x/api/crypto.html#decipherupdatedata-inputencoding-outputencoding)
- [RSAES-OAEP, RFC 8017 section 7.1](https://www.rfc-editor.org/rfc/rfc8017.html#section-7.1)

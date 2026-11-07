---
title: 'Artifact identity conformance'
description: 'Prepare a synthetic GitHub OIDC probe before considering isolated artifact-key release.'
---

# Artifact identity conformance

Artifact encryption is not implemented. The proposed external key-release service
needs a trustworthy way to distinguish jobs inside nested, matrix and repeated
workflow calls. This probe gathers synthetic platform observations for that
decision. It grants no artifact access and cannot qualify production encryption
by itself.

## Contents

- [Scope and authority](#scope-and-authority)
- [Token authentication](#token-authentication)
- [Probe graph](#probe-graph)
- [Prove the pinned graph](#prove-the-pinned-graph)
- [Collect the evidence](#collect-the-evidence)
- [Diagnose a preflight refusal](#diagnose-a-preflight-refusal)
- [Reconcile job identity](#reconcile-job-identity)
- [Acceptance limits](#acceptance-limits)

## Scope and authority

The entry workflow is `agent-ci-artifact-conformance.yml`, available only through
manual dispatch. Its reusable probe workflows capture synthetic scope/role
selectors and a strict allowlist of GitHub OIDC claims. The non-executable
reusable-call chain passes `id-token: write` to its capture leaves; no other
executable job gets OIDC authority. Other permissions are read-only. There are no model
calls, target repositories, target tokens, broker keys, arbitrary setup commands
or PR checkouts. The probe uses GitHub-hosted runners independently of the
self-hosted model-pool policy. Capture is restricted to manual runs in
`tkstang/agent-ci`; it explicitly checks out the collector from that repository
at the caller workflow SHA. This packet does not support external/private callers.

Preparing or merging this packet does not authorize dispatch, infrastructure,
credentials or production transport. Review the exact source revision and obtain
authorization for the bounded synthetic runs before dispatching. Never enable
artifact-key release on the strength of these diagnostic reports.

## Token authentication

Persisted reports now use version 2. The collector verifies the JWT signature,
issuer, exact conformance audience, expected subject and validity window before
creating staging or publishing artifact selectors. Successful reports carry
`signature_verified: true`, `subject_policy_verified: true` and
`validity_verified: true`; they remain `diagnostic_only: true` and
`selectors_are_grants: false`. The inspection helper alone still returns
unverified version-1 diagnostics and cannot publish a report.

Verification accepts RS256 with a unique matching public RSA key from the fixed
GitHub issuer JWKS endpoint, fetched over HTTPS without redirects or request
credentials. Each capture fetches fresh keys, with a 10-second total deadline,
64-KiB response bound and at most 16 keys. Keys must be 2,048–4,096 bits. Token
headers cannot supply a key or redirect verification. Duplicate JSON keys,
noncanonical encodings and unsupported algorithms refuse. JWTs require integer
`iat`, `nbf` and `exp`, a positive lifetime no longer than one hour, and validity
within 60 seconds of clock skew. A verification failure returns `E_OIDC_VERIFY`
with a closed reason, without token, claims, key material or exception text.

The subject policy is deliberately narrow: the immutable-ID repository/owner
branch format configured for `tkstang/agent-ci`, with IDs matched to runtime
claims and the exact `GITHUB_REF` branch. The caller workflow reference must end
with that branch. Legacy, custom, tag and environment subjects do not fall back
to a weaker rule. A read-only repository OIDC-settings check confirmed this
immutable subject configuration on 2026-11-07; live signature/subject acceptance
of this new collector remains unqualified. Raw subject text is never exported.
This synthetic policy is not administrator-owned broker authorization: a future
broker must independently authenticate every token and enforce its complete
caller, source, assignment and key-release contract.

## Probe graph

The graph includes two synthetic scopes, producer/consumer roles, nested reusable
calls, repeated scope selectors in separate invocations and an optional branch.
Scopes and roles in a report are observations supplied by the workflow, not
authorization grants. Their repetition is intentional: neither a scope string
nor a short job name can identify an assignment by itself.

Exercise optional branches both disabled and enabled. A complete rerun creates a
new run attempt; reports and Jobs REST records from different attempts must never
be combined. Selective job reruns do not qualify the proposed full-graph rerun
policy.

## Prove the pinned graph

From a trusted checkout of this proof implementation, run:

```sh
pnpm exec tsx src/artifact-conformance/prove.ts FULL_40_CHARACTER_COMMIT_SHA
```

Replace the placeholder with the exact reviewed commit containing the three
synthetic workflows. The command accepts a full lowercase commit SHA, reads the
three workflows from that commit with bounded Git operations and disables Git
replacement objects. It never reads workflow source from the worktree or accepts
a movable branch/tag as the revision. It emits one JSON result with `sourceSha`,
raw-source SHA-256 digests, all eight assignments and `productionQualified: false`.
A missing, oversized, malformed or changed graph returns `E_CONFORMANCE_GRAPH`.
The reviewer must separately trust the proof implementation and approved source
SHA; a digest is not proof of provenance or permission to run it.

The recognizer accepts only the complete reviewed semantic blueprint of these
three synthetic workflows. All fields, steps, permissions, names, expressions,
matrices and reusable calls must match; unknown authority, additional jobs,
inputs or dynamic expansion refuse. Duplicate keys, YAML aliases and explicit
tags refuse. Whitespace/comment changes can pass but yield different digests.
The enumerated graph contains four invocations, each with producer and consumer:
`matrix:scope-a`, `matrix:scope-b`, `repeated:scope-a`, `optional:scope-b`. The
optional-off graph removes exactly the final two assignments. All eight expanded
names and invocation/scope/role identities must be unique, including jobs that
have not appeared in Jobs REST yet.

This is a constrained synthetic proof, not a general GitHub Actions interpreter,
a production assignment policy, a Jobs REST reconciler or a grant registry. Live
GitHub rendering and report-to-job mapping still require independent evidence
for the exact approved revision. Production fleet admission needs its own
current-source expanded job list and review.

## Collect the evidence

After source review and separate dispatch authorization:

1. Record the exact caller and reusable workflow revisions. Ensure the manual
   workflow is available on the repository's default branch; GitHub requires
   that before accepting `workflow_dispatch` for another ref.
2. Run the approved ref with the optional branch disabled, then with it enabled.
   Record run IDs and attempts. Never substitute a different ref after approval.
3. Rerun a complete approved graph and retain each attempt's evidence separately.
4. Download only this probe's reports into private local staging. Fetch every
   page of the corresponding attempt-specific Jobs REST endpoint:

   ```sh
   gh api --paginate --slurp \
     'repos/tkstang/agent-ci/actions/runs/RUN_ID/attempts/ATTEMPT/jobs?per_page=100'
   ```

   Replace the two numeric placeholders with the recorded run and attempt.
   Avoid the latest-attempt endpoint, which can silently change during a rerun.

Reports omit the JWT, OIDC request credential/URL, GitHub token, arbitrary claims,
raw subject text and environment. Treat reports as platform metadata: repository
IDs and workflow identities are correlatable. Do not add private target names, contents or logs.
Failures must produce a fixed diagnostic, without HTTP bodies or token dumps.
Do not print raw OIDC tokens to diagnose a failed or missing claim.

## Diagnose a preflight refusal

An `E_INVALID_INPUT` result includes a closed `reason` identifying the first
failed preflight check. These reasons describe the check only; they never include
the input value, actual length, request destination or exception text.

The request credential has an independent cap of 16,384 JavaScript string
characters. This finite local resource limit gives headroom above the former
4,096-character cap; it is not a documented GitHub maximum or a guarantee that
every future credential fits. The request URL remains capped at 4,096 characters,
the response body at 32 KiB and the returned JWT at 24 KiB. None of these limits
authorizes printing a value or its actual length.

| Reason                          | Refusal                                                    |
| ------------------------------- | ---------------------------------------------------------- |
| `request_url_missing`           | The OIDC request URL is absent.                            |
| `request_url_too_long`          | The request URL exceeds the existing bound.                |
| `request_url_invalid`           | The request URL cannot be parsed.                          |
| `request_protocol_refused`      | The request does not use HTTPS.                            |
| `request_host_refused`          | The destination fails the GitHub Actions host rule.        |
| `request_userinfo_refused`      | The URL contains user information.                         |
| `request_port_refused`          | The URL specifies a disallowed port.                       |
| `request_fragment_refused`      | The URL contains a fragment.                               |
| `request_credential_missing`    | The OIDC request credential is absent or empty.            |
| `request_credential_too_long`   | The request credential exceeds the existing bound.         |
| `request_credential_line_break` | The request credential contains a line break.              |
| `runner_temp_invalid`           | The runner temporary path is absent or not absolute.       |
| `github_output_invalid`         | The GitHub output path is absent or not absolute.          |
| `preflight_exception`           | An otherwise unclassified exception interrupted preflight. |

These reasons do not change validation or authorize a destination. Preserve a
refusal without printing environment variables, credentials, request URLs or raw
exception messages. An older result containing only `E_INVALID_INPUT` does not
identify which check failed; do not infer its reason from this table.

Preflight refusals happen before the OIDC request and produce no claim report.
Retain each attempt's Jobs REST evidence and the fixed failure result, but do not
treat job records alone as OIDC identity qualification. Review any corrective
source change and obtain new bounded dispatch approval before another live run.

## Reconcile job identity

For each authenticated version-2 report, require `check_run_id` and an exact
match of the caller repository ID, run ID, attempt and source revisions. Inspect
the canonical `check_run_url` on every Jobs REST entry and extract its check-run
ID. **The Jobs REST job `id` is a different field; equality must not be assumed.**
Match each report to exactly one entry from that attempt, retaining the complete
nested job name and actual leaf `job_workflow_ref`/`job_workflow_sha`. Compare
repeated invocations, matrix roles and optional paths. Missing, malformed,
ambiguous, truncated or inconsistent evidence fails the candidate. Preserve the
failure; do not fall back to run-wide identity or matching name prefixes.

The observed report/Jobs match is still not an authorization proof. Independently
review the entire pinned workflow graph and assignment policy, including jobs
that have not appeared in Jobs REST yet. Show that no future matrix expansion,
optional branch, repeated invocation, duplicate name or caller-controlled input
can claim another assignment. Test deliberate collisions and name mutation
against that policy before any key can be released. The constrained proof above
covers only the synthetic graph; this packet provides no production graph
verifier, grant registry or key-release enforcement.

## Acceptance limits

Historical observations at `f8de84e84cc9c182f30ac3ca5fb223a33d128c7b` succeeded
for optional-off run `42293959035/1` (six reports) and optional-on run
`42296000371/1` plus its complete rerun `/2` (eight reports each). Reports mapped
one-to-one to attempt-specific canonical check-run URLs. The rerun retained the
same names/selectors/source with no shared job or check-run IDs. Those reports
are version 1, **signature unverified**; adding verification code does not
retroactively authenticate them. Their bounded dispatch allowances are exhausted.
The new collector and graph proof need separately authorized live acceptance.

Record observed claims and job mappings, source revisions, run attempts, missing
cases and reviewer findings. A successful workflow only proves that the probe
ran. Local tests exercise signature verification, output suppression, transport
refusals and the constrained graph; they do not establish live GitHub acceptance
or production assignment uniqueness.

The isolated transport design still requires the following before implementation
can be accepted:

- A reviewed packaging decision for the second deployable, plus hosting, TLS,
  credential and private-key custody decisions before provisioning.
- A signature-verifying broker, administrator-owned workflow/assignment policy,
  durable registry and scoped key release with no shared unwrap authority inside
  jobs executing PR or setup code.
- Authenticated streaming envelopes and coverage of every maintained upload,
  download and failure-diagnostic path, followed by public/private live acceptance.

The existing [security model](security-model.md) and [fleet setup](fleet-repo.md)
remain in force. Plaintext artifacts remain plaintext until an independently
reviewed transport implementation and its live acceptance are complete.

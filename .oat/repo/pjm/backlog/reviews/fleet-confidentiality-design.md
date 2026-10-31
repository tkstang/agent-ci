# Fleet confidentiality: transport boundary choice

Prepared 2026-10-31 for **BL-261025-fleet-repositories-merged — Fleet repositories: merged target lists and protected artifacts**.
No encryption transport is implemented or accepted by this proposal.

## Existing boundary

Verification runs pull-request code without model or helper credentials.
The built helpers are carried in an artifact so the verify job does not
need a credential-bearing helper checkout. Setup jobs likewise run arbitrary
caller commands separately from model credentials. Step-scoped environment
variables do not prevent persistent code on the same runner from reading a
later step's secret or runner state.

## Conflict

Encrypting every artifact with a shared `AGENT_CI_ARTIFACT_KEY` requires the
verify runner to decrypt its helper/spec artifacts and encrypt its evidence.
The setup runner also encrypts its prepared workspace after executing caller
code. Giving these jobs a fleet-wide symmetric key adds decryption authority
that existing credential-free wording and guarantees do not include. It cannot
be solved just by keeping the key out of the command's environment.

The inventory after review-pass extraction has nine upload sites and
fifteen download sites: prepared workspace, agent/tools results, review
spec, helper bundle, checks, reviewer passes, adjudication and gated findings.
The helper bundle also needs a trusted decrypt bootstrap before the built CLI
is available. Exempting an artifact silently would violate the requested
all-artifacts guarantee.

## Options for the operator

1. **Preserve the boundary; reject incompatible encrypted modes.** Ship
   encrypted ordinary runs/reviews only where key authority is already
   deliberately admitted. Reject encrypted verify-review and encrypted
   arbitrary setup before those jobs run. Explain the limit and keep
   full encryption acceptance open until the transport can support them.
2. **Preserve the boundary; design a different transport.** Explore
   asymmetric encryption and isolated transport/decryption lifetimes, with
   an explicit proof that no fleet decryption key reaches a job executing
   PR/setup code. Public-key uploads alone do not solve private-key access
   for encrypted inputs. This is a larger design than the original small
   symmetric-key feature and requires review before implementation.
3. **Explicitly accept artifact-key authority in those jobs.** Keep model
   credentials isolated but revise the verification/setup guarantees to
   acknowledge a shared fleet decryption key. This weakens the existing
   credential boundary and must not be selected implicitly.

Option 1 provides a bounded initial delivery without weakening the boundary;
option 2 is the path to full acceptance while retaining it. No secret is created,
read, changed or deleted for any option during preparation.

## Option 2 feasibility check

Read-only assessment at source `9b6f181`, 2026-10-31. The maintained workflow
inventory is still nine upload sites and fifteen download sites. This assessment
does not select an encryption option or authorize a service, key, deployment or
workflow implementation.

### What the existing graph requires

| Boundary                        | Source evidence                                                                            | Consequence for full encrypted transport                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verification inputs and outputs | `pr-review.yml:383–407,424–441`: download helper/spec, run PR checks, upload check results | The consumer must obtain its assigned plaintext without acquiring a fleet-wide decryption key. Its outputs must become ciphertext before upload.                                                                |
| Prepared workspace              | `run-agent.yml:359–388`: execute caller setup, pack and upload the tree                    | A later trusted upload step on that same runner does not isolate a fleet key from the setup code.                                                                                                               |
| Built helper bootstrap          | `src/commands/helpers.ts:18–22,69–80`; `pr-review.yml:390–396,429`                         | Decryption cannot live only inside the CLI that is itself encrypted. A small trusted bootstrap must already be available and pinned.                                                                            |
| Job isolation                   | `docs/security-model.md:18–21,329–330`                                                     | An environment variable used in an earlier/later step, or later reuse of the same runner, is not proof of key isolation.                                                                                        |
| Scheduling                      | `fan-out.yml:207,261`; proposed runner profile in actions-runner draft #6                  | Matrix `max_parallel: 1` is separate from the proposed one-global-slot runner limit. A concurrent broker job waiting for a consumer on that same sole slot can stall. Neither is proof of installed host state. |

A serial decrypt/upload job must still hand its result to the next job. Uploading
plaintext breaks encrypted transport; re-encrypting it moves the question to how
the consumer obtains only its assigned key. Public-key encryption lets a producer
upload ciphertext without a private key, but does not resolve consumer input
access. Existing `needs` dependencies and artifact-ID outputs provide no live
channel after a producing job exits.

### Additional mechanism to evaluate

A plausible full-support design keeps the existing artifact IDs, digests and job
dependencies, and uses envelope encryption with a separate authority that unwraps
only an authorized consumer's input keys. Producers hold the encryption public
key; PR/setup consumers can obtain their scoped input plaintext or keys, never
the fleet private key. A caller-supplied artifact ID or a token able to download
artifacts is not sufficient authorization.

Before implementation, prove the binding between repository, run and attempt,
trusted workflow identity, consumer role and immutable artifact identity. Also
specify expiry, replay, retries, cancellation, rotation and destruction of the
consumer's job state. GitHub identity claims have not been qualified for these
bindings; do not assume the platform provides an authenticated per-job claim.

Two possible locations for that authority need comparison if option 2 is chosen:

- An external scoped unwrap service, independent of Actions job slots. This adds
  service identity, authorization policy and operational ownership.
- A protected runner-host transport boundary outside arbitrary-code execution.
  This adds isolation and provisioning requirements and must separately address
  GitHub-hosted consumers. No privileged host work is authorized by this proposal.

The decrypt bootstrap could be trusted inline workflow code, a pinned action or
a provisioned component. Its integrity and key-release authentication need review;
leaving the helper artifact plaintext silently would not meet acceptance. No
existing broker, KMS or scoped unwrap implementation was found in the reviewed
workflow/source/docs graph. That is a source inspection result, not proof that a
smaller platform-supported design is impossible.

### Scope of the artifact guarantee

The inventory and proposed encryption guarantee cover every maintained workflow
upload path, including failure/diagnostic artifacts. They do not establish that
arbitrary executable code cannot deliberately disclose its own inputs. Existing
`docs/security-model.md:325–328` records that PR code can obtain the Actions runtime
token and upload artifacts. Preventing malicious additional uploads would require
mediating that authority too. Encryption does not conceal Actions metadata or
replace the private-target output controls.

The operator's three-way choice above remains pending. Option 2 needs a reviewed
transport design before implementation; options 1 and 3 retain their stated
coverage/boundary tradeoffs. No acceptance criterion is closed by this assessment.

## Independent work

Merged file/JSON target validation, private-output suppression and fleet
templates do not require this transport choice. Private mode must cover CLI
success/error envelopes, diagnostics, step summaries and arbitrary setup
stdout/stderr, while preserving exit codes and full encrypted diagnostic
artifacts once encryption is supported. GitHub matrix/job/checkout metadata
can still reveal repository identity: do not claim anonymity from log
suppression or artifact encryption.

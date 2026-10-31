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
seventeen download sites: prepared workspace, agent/tools results, review
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

## Independent work

Merged file/JSON target validation, private-output suppression and fleet
templates do not require this transport choice. Private mode must cover CLI
success/error envelopes, diagnostics, step summaries and arbitrary setup
stdout/stderr, while preserving exit codes and full encrypted diagnostic
artifacts once encryption is supported. GitHub matrix/job/checkout metadata
can still reveal repository identity: do not claim anonymity from log
suppression or artifact encryption.

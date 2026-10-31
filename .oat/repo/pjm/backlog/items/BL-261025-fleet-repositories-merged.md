---
id: BL-261025-fleet-repositories-merged
title: 'Fleet repositories: merged target lists and protected artifacts'
status: open
priority: high
scope: feature
scope_estimate: L
labels:
  - fleet
  - security
  - workflows
assignee: null
created: 2026-10-25T22:20:20.485Z
updated: 2026-10-31T22:00:00.000Z
associated_issues: []
external_plans: []
---

## Description

Support the two-fleet setup (public agent-ci-fleet on GitHub-hosted runners, private agent-ci-private-fleet on self-hosted runners; see the agent-ci-v1 operator notes 2026-10-25). Add a targets_json input (an Actions variable holding a JSON array) merged with targets_file and validated together by agent-ci targets matrix. Add optional artifact encryption with isolated, scoped key release so a public fleet's artifacts (the prepared workspace bundle holds the target's full tree) are not downloadable in clear text, and keep logs minimal for targets marked private. Ship public and private fleet templates.

## Acceptance Criteria

- `fan-out.yml` accepts `targets_json` alongside `targets_file`; both are merged and validated together (schema, unique ids and repositories, allowedOwners, routing policy, matrix bound), and a malformed variable fails before any job runs
- Optional artifact encryption: when enabled, every maintained uploaded artifact (prepared workspace, run results, change sets, review bundles and diagnostics) is encrypted and verified by digest after authenticated decryption. PR/setup jobs receive only their assigned input keys/plaintext, never shared fleet decryption authority. Disabled mode preserves behavior where caller policy allows it; enabled or required mode never falls back to plaintext. The operator selected isolated transport for full support on 2026-10-31, replacing the original shared fleet-key mechanism while preserving the coverage requirement.
- Targets can be marked private so their agent output and file lists stay out of job logs
- Public and private fleet templates in `consumer-workflows/`, and `docs/fleet-repo.md` describes both fleets and the public-repository exposure

## Progress

- 2026-10-30: the private fleet `tkstang/agent-ci-private-fleet` exists and runs `fan-out.yml` pinned to a commit SHA, on GitHub-hosted runners until a self-hosted runner is admitted. It uses `targets_file` only. `targets_json`, artifact encryption, private-target log suppression, the public fleet and the two templates are not started.

- 2026-10-31: prepared ordered `targets_json` append with combined schema,
  uniqueness, owner and bounds checks; explicit JSON-only mode; per-target
  private-output controls across CLI payloads/errors, diagnostics, review step
  summaries and setup stdout/stderr; public and private caller templates.
  No target repositories were chosen or external callers changed. Artifacts
  remain plaintext. The [transport choice](../reviews/fleet-confidentiality-design.md)
  was resolved in favor of isolated transport because a shared key in PR/setup runners would alter their
  credential boundary. Encryption and live acceptance remain open; this item
  is not archived.

- 2026-10-31: isolated transport selected; the [proposed design and acceptance plan](../../../reference/research/fleet-artifact-transport.md) covers all nine upload/fifteen download sites. External broker, exact-job grants and bootstrap remain proposed and unqualified. No encryption or service has shipped.

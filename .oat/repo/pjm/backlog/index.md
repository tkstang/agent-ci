# OAT Backlog Index

> Generated backlog table lives inside the managed section below. Keep curated narrative updates in the overview section so CLI regeneration stays safe.

## Curated Overview

- agent-ci v1 shipped (PR #25, 2026-10-26); its p02-p06 items are archived. Open work is follow-up from that delivery and the run-up to making the repository public.
- Active: the self-hosted runner and proxy (proxy override shipped in PR #29; runner admission pending) and the flaky moved-base publish test.
- Planned: route qualification, fleet target lists and protected artifacts, the Codex login route, publishing to the calling repository with an App token. Sequencing is in `pjm/roadmap.md`.

<!-- OAT BACKLOG-INDEX -->

| ID                                     | Title                                                               | Status | Priority | Scope   | Estimate |
| -------------------------------------- | ------------------------------------------------------------------- | ------ | -------- | ------- | -------- |
| BL-261025-fleet-repositories-merged    | Fleet repositories: merged target lists and protected artifacts     | open   | high     | feature | L        |
| BL-261025-codex-chatgpt-login-route    | Codex ChatGPT-login route for the private fleet                     | open   | medium   | task    | M        |
| BL-261030-make-the-moved-base-publish  | Make the moved-base publish test deterministic                      | open   | medium   | task    | S        |
| BL-261025-qualify-the-ci-routes-live   | Qualify the CI routes live                                          | open   | medium   | task    | S        |
| BL-261025-self-hosted-runner-and-proxy | Self-hosted runner and proxy readiness                              | open   | medium   | task    | S        |
| BL-261025-publish-to-the-calling       | Publish to the calling repository with an optional GitHub App token | open   | low      | feature | S        |

<!-- END OAT BACKLOG-INDEX -->

## Notes

- Active item files live in `backlog/items/`
- Archived item files live in `backlog/archived/`
- Historical completions are summarized in `backlog/completed.md`

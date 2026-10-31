# Roadmap

This file records prioritized direction and lives under `pjm/` (the operational
layer). To reduce cross-worktree conflicts, prefer adding or moving single
bullet lines over rewriting whole sections, and reference backlog records by ID
(`BL-YYMMDD-slug`) rather than restating their detail here.

## Now (Active / Committed)

<!-- Add active work here. Format:
- **BL-YYMMDD-slug: {title}** — brief description. Project: {name} (if linked)
-->

- **Active delivery goal:** [Review and fleet readiness](backlog/reviews/review-and-fleet-readiness-goal.md), activated 2026-10-31. Ordered work below; merges, credential changes and privileged runner activation retain their approval boundaries.
- **Reviewer configuration prerequisite** — Sol 6.1 High primary, optional Opus 5.5 High second, Sol 6.1 Low adjudicator; enable Claude Code pool CI with self-hosted and explicit opt-in guards. The Sol adjudicator transport choice is pending; generic defaults enable only the primary, personal callers should enable primary plus adjudicator once supported.
- **BL-261025-self-hosted-runner-and-proxy: Self-hosted runner and proxy readiness** — first after reviewer configuration. Prepare explicit fleet admission to the runner's fixed allowlist, complete approved host qualification and one live `allow_pool` job, and prepare a versioned release. Existing proxy-origin override is implemented. Fleet caller migration needs separate authorization; source-secret deletion still needs a no-reader check and explicit approval.
- **BL-261025-fleet-repositories-merged: Fleet repositories: merged target lists and protected artifacts** — deliver target-list merging, private logging and artifact protection as coherent slices after runner and core workflow preparation.
- **BL-261030-make-the-moved-base-publish: Make the moved-base publish test deterministic** — intermittent CI failure on unrelated changes.

## Next (Planned)

<!-- Add planned work here. Format:
- **BL-YYMMDD-slug: {title}** — brief description. Project: {name} (if linked)
-->

- **BL-261025-qualify-the-ci-routes-live: Qualify the CI routes live** — reconcile the retained catalog and qualify selected production routes. DeepSeek already has qualification evidence; new Sol High/Low and Opus High routes require fresh live evidence. Existing test-route gaps do not authorize metered API spend.
- **BL-261025-publish-to-the-calling: Publish to the calling repository with an optional GitHub App token** — so generated pull requests in the calling repository get CI automatically; today their `pull_request` runs wait for a write user's approval.
- **BL-261025-codex-chatgpt-login-route: Codex ChatGPT-login route for the private fleet** — runner-local `auth.json`, serialized jobs, per OpenAI's trusted-private-automation guidance.

Shipped in agent-ci-v1 (PR #25, merged 2026-10-26; archived backlog items): BL-261025-reusable-run-agent-workflow (p02), BL-261025-ai-pull-request-review (p03), BL-261025-verify-review-run-check-tool (p04), BL-261025-use-case-wrappers-and-multi (p05), BL-261025-documentation-tree-and-docs (p06). Shipped after it: DeepSeek V4.1 Flash and GLM 5.3 Flash routes (PR #28), the `AGENT_CI_PROXY_BASE_URL` override (PR #29).

## Later (Directional Intent)

<!-- Add directional work here. Format:
- **BL-YYMMDD-slug: {title}** — brief description. Project: {name} (if linked)
-->

- PR review rollout to personal repositories (personal-skills and orc first, then personal-mcp; others after the repository is public).
- Published package for helper distribution, if a public checkout proves insufficient.

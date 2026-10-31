# Roadmap

This file records prioritized direction and lives under `pjm/` (the operational
layer). To reduce cross-worktree conflicts, prefer adding or moving single
bullet lines over rewriting whole sections, and reference backlog records by ID
(`BL-YYMMDD-slug`) rather than restating their detail here.

## Now (Active / Committed)

<!-- Add active work here. Format:
- **BL-YYMMDD-slug: {title}** — brief description. Project: {name} (if linked)
-->
- Complete the public-source cleanup PR — the repository is public and agent-ci-v1 is archived. After the cleanup merges, verify fleet workflows no longer read `AGENT_CI_SOURCE_TOKEN` and obtain explicit approval before deleting the fleet secret.
- **BL-261025-self-hosted-runner-and-proxy: Self-hosted runner and proxy readiness** — proxy origin override shipped (PR #29); runner admission (`tkstang/actions-runner`) and the first live `allow_pool` job remain, plus a release tag.
- **BL-261030-make-the-moved-base-publish: Make the moved-base publish test deterministic** — intermittent CI failure on unrelated changes.

## Next (Planned)

<!-- Add planned work here. Format:
- **BL-YYMMDD-slug: {title}** — brief description. Project: {name} (if linked)
-->
- **BL-261025-qualify-the-ci-routes-live: Qualify the CI routes live** — `claude-haiku-4-5-personal`, `claude-haiku-4-5-api`, `glm-5.3-flash-opencode` and `deepseek-v4.1-flash-opencode` still `qualified: null` (the DeepSeek route has since run live in the private fleet); the Claude routes need the operator's credentials.
- **BL-261025-close-remaining-claude-only: Close remaining Claude-only policy name-check gaps** — before adding a Cursor `auto` or separator-less Claude-like route.
- **BL-261025-publish-to-the-calling: Publish to the calling repository with an optional GitHub App token** — so generated pull requests in the calling repository get CI automatically; today their `pull_request` runs wait for a write user's approval.
- **BL-261025-fleet-repositories-merged: Fleet repositories: merged target lists and protected artifacts** — two fleets (public `agent-ci-fleet` on GitHub-hosted runners, private `agent-ci-private-fleet` on self-hosted); `targets_json` merged with `targets_file`; optional artifact encryption for public-fleet artifacts.
- **BL-261025-codex-chatgpt-login-route: Codex ChatGPT-login route for the private fleet** — runner-local `auth.json`, serialized jobs, per OpenAI's trusted-private-automation guidance.
- **BL-261025-post-v1-simplification-pass: Post-v1 simplification pass** — verify-isolation trim, review-pass workflow boundary, unused inputs, workflow and rule dedupe, in-place git-dir pinning (from the PR #25 complexity review).

Shipped in agent-ci-v1 (PR #25, merged 2026-10-26; archived backlog items): BL-261025-reusable-run-agent-workflow (p02), BL-261025-ai-pull-request-review (p03), BL-261025-verify-review-run-check-tool (p04), BL-261025-use-case-wrappers-and-multi (p05), BL-261025-documentation-tree-and-docs (p06). Shipped after it: DeepSeek V4.1 Flash and GLM 5.3 Flash routes (PR #28), the `AGENT_CI_PROXY_BASE_URL` override (PR #29).

## Later (Directional Intent)

<!-- Add directional work here. Format:
- **BL-YYMMDD-slug: {title}** — brief description. Project: {name} (if linked)
-->
- PR review rollout to personal repositories (personal-skills and orc first, then personal-mcp; others after the repository is public).
- Published package for helper distribution, if a public checkout proves insufficient.

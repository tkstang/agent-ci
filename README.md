# agent-ci

agent-ci is a toolkit for automating repository work with coding agents.
Run a prompt against a Git repository and publish the result as a pull
request, a comment or a code review, locally or from GitHub Actions.

It provides a TypeScript CLI and reusable GitHub Actions workflows, with
integrations for **Claude Code, Codex, OpenCode and Cursor**. The workflows
coordinate repository setup, agent execution and publishing. A checked-in
routing table (`models.yaml`) selects the model's harness, credentials and
account under an enforced routing policy.

Use these capabilities for your own automation, or start with the included
integrations below.

## Included integrations

| Integration                              | What it does                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [Prompt-driven tasks](docs/workflows.md) | Run a chosen model on a task and optionally publish its changes as a pull request.                                       |
| [Pull-request review](docs/pr-review.md) | Review changes on request, with optional independent reviewers and repository check results.                             |
| [OAT maintenance](docs/workflows.md)     | Use Open Agent Toolkit (OAT) to update documentation, agent instructions or installed tools through dedicated workflows. |
| [Fleet maintenance](docs/fleet-repo.md)  | Run maintenance across a configured list of repositories on a schedule or on demand.                                     |

Copy a caller from [`consumer-workflows/`](consumer-workflows/) into your
repository, pin the agent-ci commit and configure the credentials its
selected route needs. [Workflows](docs/workflows.md) describes the reusable
interfaces and templates. The OAT tools-update workflow is deterministic
and needs no model credential.

## Quick start

Requires Node.js 24 and pnpm 11. This run needs no credential and calls no
model:

```bash
pnpm install
pnpm build
cd /path/to/a/git/repository
node /path/to/agent-ci/dist/cli.js run --model fake-echo --prompt "Summarize this repository."
```

It writes `.agent-ci/run-result.json`, `run-log.jsonl` and `prompt.md`.
[Getting started](docs/getting-started.md) continues with a real model.

Run `agent-ci --help` for every command. Use `agent-ci models`,
`agent-ci route` and `agent-ci doctor` to inspect the available models,
routing and local setup.

## Documentation

Start at the [documentation index](docs/index.md):

- [Getting started](docs/getting-started.md)
- [Harnesses and routing](docs/harnesses-and-routing.md)
- [Workflows](docs/workflows.md)
- [PR review](docs/pr-review.md)
- [Configuration and credentials](docs/configuration.md)
- [Using agent-ci from another repository](docs/fleet-repo.md)
- [Security model](docs/security-model.md)

## Development

| Command                             | Does                                     |
| ----------------------------------- | ---------------------------------------- |
| `pnpm typecheck`                    | Type check with `tsrs`                   |
| `pnpm lint`                         | `oxlint`                                 |
| `pnpm format:check` / `pnpm format` | `oxfmt` check / rewrite                  |
| `pnpm test`                         | Vitest (co-located `*.test.ts`)          |
| `pnpm build`                        | Emit `dist/` with `tsrs` and `tsc-alias` |
| `pnpm docs:check`                   | Docs indexes, metadata and links         |
| `pnpm check:agents`                 | Fail if any `CLAUDE.md` exists           |

Normal CI verification and workflow linting run for ready PRs targeting `main`,
including `ready_for_review` and later code updates. Draft PRs skip those jobs
before runner allocation; pushes to `main` retain full validation. Explicit
label/manual self-tests and reusable workflows keep their existing triggers.
Local checks remain required before handoff.

Conventions for agents and contributors are in [AGENTS.md](AGENTS.md);
documentation conventions are in [docs/contributing.md](docs/contributing.md).

## License

MIT; see [LICENSE](LICENSE).

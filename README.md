# agent-ci

Run a chosen model through Claude Code, Codex, OpenCode or Cursor against a
repository, from GitHub Actions or the command line, and publish the result
as a pull request, a comment or a pull-request review.

agent-ci is a TypeScript CLI (`agent-ci`) and a set of reusable GitHub
Actions workflows that call it. A checked-in routing table (`models.yaml`)
decides which harness, credential and account each model uses, and enforces
the routing policy: Claude models run only in Claude Code, and no run falls
back from a subscription to paid API billing.

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

## What it does

| Capability                                                                                                 | Entry point                                                                     |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Run one prompt with a model, locally or in Actions                                                         | `agent-ci run`, `run-agent.yml`                                                 |
| AI pull-request review on request, with an optional verify-review mode that cites repository check results | `agent-ci review run`, `pr-review.yml`                                          |
| OAT docs, agent-instructions and tools updates for one repository or a fleet                               | `docs-update.yml`, `instructions-update.yml`, `tools-update.yml`, `fan-out.yml` |
| Inspect harnesses, credentials and routes                                                                  | `agent-ci doctor`, `agent-ci models`, `agent-ci route`                          |

Run `agent-ci --help` for every command.

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

Conventions for agents and contributors are in [AGENTS.md](AGENTS.md);
documentation conventions are in [docs/contributing.md](docs/contributing.md).

## License

MIT; see [LICENSE](LICENSE).

---
title: Contributing to documentation
description: Authoring conventions, context, and Markdown navigation rules.
---

# Contributing to documentation

Maintain documentation for **agent-ci** as authored Markdown pages. Start
from the [documentation index](index.md) to understand the intended audience and
where each topic belongs.

## Structure and context

- Give every Markdown-bearing directory an authored `index.md` with useful
  context: purpose, audience, ownership, and how its pages relate.
- Maintain a populated `## Contents` map. Link sibling pages as `page.md` and
  immediate child directories as `section/index.md`. Link only existing files.
- Asset-only directories do not need an index.
- Add `title` and `description` metadata to authored pages. Use relative `.md`
  links so navigation works when reading the repository directly.
- Preserve existing local instructions and repository-specific guidance.

## Review and verification

`pnpm docs:check` is the required check. Maintainers may also use the
optional OAT docs skills (`oat-docs-analyze` to find content, metadata and
navigation gaps, `oat-docs-apply` for approved repairs); contributors do not
need them.

Check relative links, Contents maps, metadata, and context after edits with
`pnpm docs:check`. It fails when a reader directory has no `index.md` with a
`## Contents` map, a page is missing from that map, a page lacks `title` or
`description` front matter, or a relative link or heading anchor in `docs/`,
`README.md` or `AGENTS.md` does not resolve. CI runs it. `pnpm format` formats
Markdown with oxfmt; there is no Markdown linter and no site build.

The authored index is not a generated manifest. Do not replace it with a
generated inventory.

## Information architecture

The structure is recorded in the repository decision record
[DR-261025-organize-the-docs-as-one-flat](../.oat/repo/reference/decisions/DR-261025-organize-the-docs-as-one-flat.md)
(accepted). It describes one flat `docs/` directory and one `index.md` whose `## Contents` map groups
the reader pages under `###` headings (Start, Use, Set up, Concepts,
Contributing).

- **One fact, one owning page.** Credentials and runner setup live in
  `configuration.md`; the routing policy in `harnesses-and-routing.md`; trust
  boundaries and residual risk in `security-model.md`. Other pages link to
  the owner instead of restating it.
- **Source wins.** Workflow inputs, CLI flags and error codes are canonical
  in the workflow files and `agent-ci <command> --help` (or
  `agent-ci <command> <subcommand> --help`); pages summarize them
  and name the file. When a page and the code disagree, fix the page, or
  record the code defect, rather than describing behavior the code does not
  have.
- **New pages** join an existing `###` group and the index in the same
  change. Graduate to folders past about 15 reader pages or when one group
  passes about 8 entries, as the decision record describes.
- **Out of scope for `docs/`:** project history, plans, backlog and review
  records, which stay in the repository's OAT project-management area, and
  agent runtime rules, which stay in `AGENTS.md`.

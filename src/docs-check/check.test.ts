import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkDocs,
  type DocsConfig,
  globToRegExp,
  headingSlugs,
  loadDocsConfig,
  markdownLinks,
  renderedHeadingText,
} from './check.js';

const CONFIG: DocsConfig = {
  root: 'docs',
  index: 'docs/index.md',
  nonReaderPaths: ['contributing/templates/**'],
};

const page = (title: string, body: string) =>
  `---\ntitle: ${title}\ndescription: A description of ${title} for readers.\n---\n\n# ${title}\n\n${body}\n`;

/** A passing tree; `overrides` replaces or (with null) removes files. */
async function fixture(
  overrides: Record<string, string | null> = {},
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'docs-check-'));
  const files: Record<string, string | null> = {
    'README.md': 'See the [docs](docs/index.md#contents).\n',
    'docs/index.md': page(
      'Home',
      '## Contents\n\n### Start\n\n- [Guide](guide.md) - The guide.\n- [Section](section/index.md) - A section.\n',
    ),
    'docs/guide.md': page(
      'Guide',
      '## First steps\n\nBack to [home](index.md). Jump to [steps](#first-steps).\n\n```bash\n[not a link](missing.md)\n```\n\nInline `[code](missing.md)` and [web](https://example.com).\n',
    ),
    'docs/section/index.md': page(
      'Section',
      '## Contents\n\n- [Leaf](leaf.md) - A leaf.\n',
    ),
    'docs/section/leaf.md': page('Leaf', 'Up to [guide](../guide.md).\n'),
    'docs/contributing/templates/template.md':
      'No front matter and [a placeholder](<target>.md).\n',
    ...overrides,
  };
  for (const [name, text] of Object.entries(files)) {
    if (text === null) continue;
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  return root;
}

const run = async (repoRoot: string, config: DocsConfig = CONFIG) =>
  checkDocs({ repoRoot, config, extraFiles: ['README.md'] });

describe('checkDocs', () => {
  it('passes a complete tree and ignores code, external links and non-reader paths', async () => {
    expect(await run(await fixture())).toEqual([]);
  });

  it('requires an index.md with a non-empty Contents map in every reader directory', async () => {
    const missing = await run(await fixture({ 'docs/section/index.md': null }));
    expect(missing).toContainEqual(
      expect.objectContaining({
        rule: 'directory-index',
        path: 'docs/section/index.md',
      }),
    );
    const empty = await run(
      await fixture({
        'docs/section/index.md': page('Section', 'No map here.'),
      }),
    );
    expect(empty).toContainEqual(
      expect.objectContaining({
        rule: 'directory-index',
        message: 'index.md needs a non-empty ## Contents map',
      }),
    );
  });

  it('reports pages and sections the Contents map does not list', async () => {
    const findings = await run(
      await fixture({
        'docs/orphan.md': page('Orphan', 'Nobody links here.'),
        'docs/index.md': page(
          'Home',
          '## Contents\n\n- [Guide](guide.md) - The guide.\n- [Orphan](orphan.md) - x.\n',
        ),
      }),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        rule: 'unlisted',
        path: 'docs/section/index.md',
      }),
    ]);
    const orphan = await run(
      await fixture({ 'docs/orphan.md': page('Orphan', 'Unlisted.') }),
    );
    expect(orphan).toEqual([
      expect.objectContaining({ rule: 'unlisted', path: 'docs/orphan.md' }),
    ]);
  });

  it('requires title and description front matter on reader pages', async () => {
    const findings = await run(
      await fixture({
        'docs/guide.md':
          '---\ntitle: Guide\n---\n\n# Guide\n\n[home](index.md)\n',
      }),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        rule: 'metadata',
        path: 'docs/guide.md',
        message: 'front matter needs a non-empty description',
      }),
    ]);
  });

  it('reports links that do not resolve or leave the repository, in docs and extra files', async () => {
    const findings = await run(
      await fixture({
        'README.md': 'A [broken](docs/nope.md) link.\n',
        'docs/section/leaf.md': page(
          'Leaf',
          'Out of [repo](../../../outside.md).\n\n[ref]: ./gone.md\n',
        ),
      }),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        rule: 'link',
        path: 'docs/section/leaf.md',
        message: 'link ../../../outside.md leaves the repository',
      }),
      expect.objectContaining({
        rule: 'link',
        path: 'docs/section/leaf.md',
        message: 'link ./gone.md does not resolve',
      }),
      expect.objectContaining({
        rule: 'link',
        path: 'README.md',
        line: 1,
        message: 'link docs/nope.md does not resolve',
      }),
    ]);
  });

  it('reports anchors that name no heading, in the same file or another', async () => {
    const findings = await run(
      await fixture({
        'docs/section/leaf.md': page(
          'Leaf',
          'See [guide](../guide.md#nowhere) and [here](#missing) and [guide](../guide.md#first-steps).\n',
        ),
      }),
    );
    expect(findings.map((finding) => finding.message)).toEqual([
      'anchor #nowhere is not a heading in docs/guide.md',
      'anchor #missing is not a heading in docs/section/leaf.md',
    ]);
  });

  it('accepts anchors to formatted and repeated headings as GitHub renders them', async () => {
    const formatted = page(
      'Guide',
      '## _Setup_\n\n## `run_check` tool\n\n## foo\n\n## foo-1\n\n## foo\n\nBack to [home](index.md).\n',
    );
    const linking = page(
      'Leaf',
      'See [setup](../guide.md#setup), [tool](../guide.md#run_check-tool) and [third](../guide.md#foo-2).\n',
    );
    expect(
      await run(
        await fixture({
          'docs/guide.md': formatted,
          'docs/section/leaf.md': linking,
        }),
      ),
    ).toEqual([]);
    const stale = await run(
      await fixture({
        'docs/guide.md': formatted,
        'docs/section/leaf.md': page(
          'Leaf',
          'See [setup](../guide.md#_setup_) and [dup](../guide.md#foo-1-1).\n',
        ),
      }),
    );
    expect(stale.map((finding) => finding.message)).toEqual([
      'anchor #_setup_ is not a heading in docs/guide.md',
      'anchor #foo-1-1 is not a heading in docs/guide.md',
    ]);
  });

  it('reports a missing docs root or authored index as configuration errors', async () => {
    const root = await fixture();
    expect(await run(root, { ...CONFIG, root: 'documentation' })).toEqual([
      expect.objectContaining({ rule: 'config', path: 'documentation' }),
    ]);
    expect(
      await run(root, { ...CONFIG, index: 'docs/home.md' }),
    ).toContainEqual(expect.objectContaining({ rule: 'config' }));
  });

  it('checks non-reader paths as reader pages once they are no longer excluded', async () => {
    const findings = await run(await fixture(), {
      ...CONFIG,
      nonReaderPaths: [],
    });
    expect(findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining(['directory-index', 'metadata', 'link']),
    );
  });
});

describe('helpers', () => {
  it('builds GitHub heading slugs, numbering duplicates and skipping code', () => {
    const slugs = headingSlugs(
      '# `agent-ci run` (local)\n## Pool & CI\n## Pool & CI\n```md\n# Not a heading\n```\n## [Linked](x.md) title\n',
    );
    expect([...slugs]).toEqual([
      'agent-ci-run-local',
      'pool--ci',
      'pool--ci-1',
      'linked-title',
    ]);
  });

  it('slugs rendered heading text and keeps every duplicate suffix unique', () => {
    expect([
      ...headingSlugs(
        '## _Setup_\n## **Bold** and *em*\n## `run_check` tool\n## snake_case name\n## __init__ hooks\n## foo\n## foo-1\n## foo\n## foo\n',
      ),
    ]).toEqual([
      'setup',
      'bold-and-em',
      'run_check-tool',
      'snake_case-name',
      'init-hooks',
      'foo',
      'foo-1',
      'foo-2',
      'foo-3',
    ]);
    expect(renderedHeadingText('A [*linked*](x.md) `a_b` _c_')).toBe(
      'A linked a_b c',
    );
  });

  it('extracts inline links, angle-bracket targets and reference definitions', () => {
    expect(
      markdownLinks('[a](b.md "Title") [c](<d e.md>)\n[ref]: f.md#g\n'),
    ).toEqual([
      { line: 1, target: 'b.md' },
      { line: 1, target: 'd e.md' },
      { line: 2, target: 'f.md#g' },
    ]);
  });

  it('matches non-reader globs against docs-relative paths', () => {
    const pattern = globToRegExp('contributing/templates/**');
    expect(pattern.test('contributing/templates/a/b.md')).toBe(true);
    expect(pattern.test('contributing/index.md')).toBe(false);
    expect(globToRegExp('*.md').test('a/b.md')).toBe(false);
  });

  it('reads the documentation section of .oat/config.json, with defaults', async () => {
    const root = await fixture({
      '.oat/config.json': JSON.stringify({
        documentation: {
          root: 'docs',
          index: 'docs/index.md',
          nonReaderPaths: ['contributing/templates/**'],
        },
      }),
    });
    expect(await loadDocsConfig(root)).toEqual(CONFIG);
    const bare = await fixture();
    expect(await loadDocsConfig(bare)).toEqual({
      root: 'docs',
      index: 'docs/index.md',
      nonReaderPaths: [],
    });
  });
});

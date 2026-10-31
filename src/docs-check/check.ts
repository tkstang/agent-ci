import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

/**
 * The repository docs check behind `pnpm docs:check`: the authored
 * Markdown tree under the configured docs root keeps its navigation
 * contract (every reader directory has an `index.md` with a `## Contents`
 * map that lists each page and child section), every reader page carries
 * `title` and `description` metadata, and every relative link in the docs,
 * the README and AGENTS.md resolves to a file, with heading anchors checked
 * against GitHub's heading slugs. Dependency-free apart from `yaml`.
 */

export const DOCS_RULES = [
  'config',
  'directory-index',
  'unlisted',
  'metadata',
  'link',
  'anchor',
] as const;
export type DocsRule = (typeof DOCS_RULES)[number];

export interface DocsFinding {
  readonly rule: DocsRule;
  /** Repository-relative path, `/`-separated. */
  readonly path: string;
  readonly line?: number;
  readonly message: string;
}

export interface DocsConfig {
  /** Docs root, repository-relative. */
  readonly root: string;
  /** Authored index, repository-relative. */
  readonly index: string;
  /** Globs relative to the docs root that hold no reader pages. */
  readonly nonReaderPaths: readonly string[];
}

export interface DocsCheckOptions {
  readonly repoRoot: string;
  readonly config: DocsConfig;
  /** Repository-relative files outside the docs root whose links are checked. */
  readonly extraFiles: readonly string[];
}

const DEFAULT_CONFIG: DocsConfig = {
  root: 'docs',
  index: 'docs/index.md',
  nonReaderPaths: [],
};

/** Read `documentation` from `.oat/config.json`; defaults when absent. */
export async function loadDocsConfig(repoRoot: string): Promise<DocsConfig> {
  let text: string;
  try {
    text = await readFile(path.join(repoRoot, '.oat', 'config.json'), 'utf8');
  } catch {
    return DEFAULT_CONFIG;
  }
  const raw = JSON.parse(text) as { documentation?: unknown };
  const docs = raw.documentation;
  if (typeof docs !== 'object' || docs === null) return DEFAULT_CONFIG;
  const record = docs as Record<string, unknown>;
  const root = typeof record.root === 'string' ? record.root : 'docs';
  return {
    root,
    index: typeof record.index === 'string' ? record.index : `${root}/index.md`,
    nonReaderPaths: Array.isArray(record.nonReaderPaths)
      ? record.nonReaderPaths.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
  };
}

/** A `**`/`*` glob as an anchored regular expression over `/` paths. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] ?? '';
    if (ch === '*' && glob[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'u');
}

const toPosix = (value: string) => value.split(path.sep).join('/');

async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkMarkdown(full)));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lines outside fenced code blocks, with inline code spans blanked unless
 * `keepInlineCode` (heading slugs keep the code text).
 */
export function proseLines(
  text: string,
  keepInlineCode = false,
): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let fence: string | null = null;
  text.split(/\r?\n/u).forEach((raw, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(raw)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = null;
      return;
    }
    if (fence !== null) return;
    out.push({
      line: index + 1,
      text: keepInlineCode ? raw : raw.replace(/(`+)[^`]*?\1/gu, ''),
    });
  });
  return out;
}

function frontMatter(text: string): Record<string, unknown> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(text);
  if (match === null) return null;
  try {
    const value = parseYaml(match[1] ?? '') as unknown;
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A heading's rendered text: code spans keep their content, links and
 * images keep their text, and emphasis markers (`*`, `_`) are dropped.
 * Underscores inside words and inside code spans stay, as GitHub keeps them.
 */
export function renderedHeadingText(heading: string): string {
  const linked = heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/gu, '$1');
  return linked
    .split(/(`+[^`]*?`+)/u)
    .map((part) => {
      const code = /^(`+)([^`]*?)\1$/u.exec(part);
      if (code !== null) return code[2] ?? '';
      return part
        .replace(/\*+/gu, '')
        .replace(/(^|[^\p{L}\p{N}_])_+(?=\S)/gu, '$1')
        .replace(/(?<=\S)_+(?=$|[^\p{L}\p{N}_])/gu, '');
    })
    .join('');
}

/**
 * GitHub's heading anchors for a Markdown document. A repeated slug gets the
 * next `-N` suffix that no earlier heading produced (`foo`, `foo-1`, `foo`
 * gives `foo`, `foo-1`, `foo-2`), as GitHub's slugger does.
 */
export function headingSlugs(text: string): Set<string> {
  const slugs = new Set<string>();
  const counts = new Map<string, number>();
  for (const { text: line } of proseLines(text, true)) {
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/u.exec(line)?.[1];
    if (heading === undefined) continue;
    const base = renderedHeadingText(heading)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s/gu, '-');
    let slug = base;
    if (slugs.has(slug)) {
      let count = counts.get(base) ?? 0;
      do {
        count += 1;
        slug = `${base}-${count}`;
      } while (slugs.has(slug));
      counts.set(base, count);
    }
    slugs.add(slug);
  }
  return slugs;
}

/** Inline links and reference definitions on prose lines. */
export function markdownLinks(
  text: string,
): { line: number; target: string }[] {
  const out: { line: number; target: string }[] = [];
  for (const { line, text: prose } of proseLines(text)) {
    for (const match of prose.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)[^)]*\)/gu)) {
      out.push({ line, target: (match[1] ?? '').replace(/^<|>$/gu, '') });
    }
    const definition = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/u.exec(prose)?.[1];
    if (definition !== undefined) out.push({ line, target: definition });
  }
  return out;
}

/** Link targets listed under the document's `## Contents` heading. */
export function contentsLinks(text: string): string[] | null {
  let inside = false;
  let found = false;
  const links: string[] = [];
  for (const { text: line } of proseLines(text)) {
    if (/^##\s+Contents\s*$/u.test(line)) {
      inside = true;
      found = true;
      continue;
    }
    if (inside && /^##\s/u.test(line)) inside = false;
    if (!inside) continue;
    for (const match of line.matchAll(/\]\(\s*([^)\s]+)[^)]*\)/gu)) {
      links.push((match[1] ?? '').split('#')[0] ?? '');
    }
  }
  return found ? links : null;
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;

/** Percent-decoding that leaves a malformed sequence as written. */
function decode(value: string, decoder: (text: string) => string): string {
  try {
    return decoder(value);
  } catch {
    return value;
  }
}

/** Run every docs rule and return the findings (empty means pass). */
export async function checkDocs(
  options: DocsCheckOptions,
): Promise<DocsFinding[]> {
  const { repoRoot, config } = options;
  const findings: DocsFinding[] = [];
  const rel = (file: string) => toPosix(path.relative(repoRoot, file));
  const docsRoot = path.resolve(repoRoot, config.root);
  if (!(await exists(docsRoot))) {
    return [
      {
        rule: 'config',
        path: config.root,
        message: `docs root ${config.root} does not exist`,
      },
    ];
  }
  if (!(await exists(path.resolve(repoRoot, config.index)))) {
    findings.push({
      rule: 'config',
      path: config.index,
      message: `authored index ${config.index} does not exist`,
    });
  }
  const nonReader = config.nonReaderPaths.map(globToRegExp);
  const all = await walkMarkdown(docsRoot);
  const reader = all.filter((file) => {
    const inRoot = toPosix(path.relative(docsRoot, file));
    return !nonReader.some((pattern) => pattern.test(inRoot));
  });

  // Directories that hold reader pages, and every ancestor up to the root.
  const readerDirs = new Set<string>();
  for (const file of reader) {
    let dir = path.dirname(file);
    while (dir.startsWith(docsRoot)) {
      readerDirs.add(dir);
      if (dir === docsRoot) break;
      dir = path.dirname(dir);
    }
  }
  const texts = new Map<string, string>();
  const read = async (file: string) => {
    const cached = texts.get(file);
    if (cached !== undefined) return cached;
    const text = await readFile(file, 'utf8');
    texts.set(file, text);
    return text;
  };

  for (const dir of [...readerDirs].toSorted()) {
    const index = path.join(dir, 'index.md');
    if (!(await exists(index))) {
      findings.push({
        rule: 'directory-index',
        path: rel(index),
        message: 'a directory with reader pages needs an index.md',
      });
      continue;
    }
    const listed = contentsLinks(await read(index));
    if (listed === null || listed.length === 0) {
      findings.push({
        rule: 'directory-index',
        path: rel(index),
        message: 'index.md needs a non-empty ## Contents map',
      });
      continue;
    }
    const resolved = new Set(
      listed.map((target) => path.resolve(dir, decode(target, decodeURI))),
    );
    for (const file of reader) {
      if (path.dirname(file) !== dir || file === index) continue;
      if (!resolved.has(file)) {
        findings.push({
          rule: 'unlisted',
          path: rel(file),
          message: `not listed in the ## Contents map of ${rel(index)}`,
        });
      }
    }
    for (const child of readerDirs) {
      if (path.dirname(child) !== dir || child === dir) continue;
      if (!resolved.has(path.join(child, 'index.md'))) {
        findings.push({
          rule: 'unlisted',
          path: rel(path.join(child, 'index.md')),
          message: `section not listed in the ## Contents map of ${rel(index)}`,
        });
      }
    }
  }

  for (const file of reader) {
    const meta = frontMatter(await read(file));
    for (const key of ['title', 'description'] as const) {
      const value = meta?.[key];
      if (typeof value !== 'string' || value.trim() === '') {
        findings.push({
          rule: 'metadata',
          path: rel(file),
          line: 1,
          message: `front matter needs a non-empty ${key}`,
        });
      }
    }
  }

  const linkSources = [
    ...reader,
    ...options.extraFiles.map((file) => path.resolve(repoRoot, file)),
  ];
  for (const file of linkSources) {
    if (!(await exists(file))) {
      findings.push({
        rule: 'config',
        path: rel(file),
        message: 'file to check does not exist',
      });
      continue;
    }
    for (const { line, target } of markdownLinks(await read(file))) {
      if (target === '' || EXTERNAL.test(target)) continue;
      const hash = target.indexOf('#');
      const pathPart = hash === -1 ? target : target.slice(0, hash);
      const anchor = hash === -1 ? '' : target.slice(hash + 1);
      const destination =
        pathPart === ''
          ? file
          : path.resolve(path.dirname(file), decode(pathPart, decodeURI));
      const inside = path.relative(repoRoot, destination);
      if (inside.startsWith('..') || path.isAbsolute(inside)) {
        findings.push({
          rule: 'link',
          path: rel(file),
          line,
          message: `link ${target} leaves the repository`,
        });
        continue;
      }
      if (!(await exists(destination))) {
        findings.push({
          rule: 'link',
          path: rel(file),
          line,
          message: `link ${target} does not resolve`,
        });
        continue;
      }
      if (anchor !== '' && destination.endsWith('.md')) {
        const slugs = headingSlugs(await read(destination));
        if (!slugs.has(decode(anchor, decodeURIComponent).toLowerCase())) {
          findings.push({
            rule: 'anchor',
            path: rel(file),
            line,
            message: `anchor #${anchor} is not a heading in ${rel(destination)}`,
          });
        }
      }
    }
  }
  return findings;
}

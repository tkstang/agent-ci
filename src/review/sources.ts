import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SAFE_GIT_ENV, safeGitArgs } from '@agent-ci/git/safe-git.js';
import {
  contractError,
  isRepoPath,
  isSha,
  type Side,
} from '@agent-ci/review/contracts.js';
import type { SourceReader } from '@agent-ci/review/diff-position.js';
import { readArtifactFile } from '@agent-ci/review/files.js';
import { type GithubClient, repositoryPath } from '@agent-ci/review/github.js';

/**
 * Trusted source at the captured SHAs for the findings gate and the
 * adjudicator, read WITHOUT a checkout of pull-request code: from the
 * GitHub git database API (Actions jobs that hold only a read token) or
 * from the git object store of a local repository (blobs only: no checkout,
 * filter, hook or textconv runs). Both read tree entry modes, so only
 * regular files count: a symlink, submodule or directory at a cited path
 * (or a symlinked parent directory) reads as missing on both sources.
 */

export const SOURCE_LIMITS = Object.freeze({
  /** Largest file read for anchors and evidence. */
  fileBytes: 4 * 1024 * 1024,
  /** Distinct (side, path) sources fetched for one gate run. */
  sources: 400,
});

export type SourceKey = { side: Side; path: string };
const keyOf = (side: Side, repoPath: string) => `${side}\u0000${repoPath}`;

/** Sources the gate will read for one set of reviewer answers. */
export function citedSources(reviews: readonly unknown[]): SourceKey[] {
  const seen = new Set<string>();
  const out: SourceKey[] = [];
  const add = (side: unknown, repoPath: unknown) => {
    if ((side !== 'RIGHT' && side !== 'LEFT') || !isRepoPath(repoPath)) return;
    const key = keyOf(side, repoPath);
    if (seen.has(key) || out.length >= SOURCE_LIMITS.sources) return;
    seen.add(key);
    out.push({ side, path: repoPath });
  };
  for (const review of reviews) {
    const findings = (review as { findings?: unknown } | null)?.findings;
    if (!Array.isArray(findings)) continue;
    for (const raw of findings) {
      const finding = raw as Record<string, unknown> | null;
      if (finding === null || typeof finding !== 'object') continue;
      add(finding.side, finding.path);
      if (Array.isArray(finding.evidence))
        for (const item of finding.evidence as unknown[]) {
          const evidence = item as Record<string, unknown> | null;
          add(evidence?.side, evidence?.path);
        }
      // Rule files are verified against the head tree.
      if (typeof finding.rule_id === 'string') {
        let rule = finding.rule_id.split('#')[0] ?? '';
        while (rule.startsWith('./')) rule = rule.slice(2);
        add('RIGHT', rule);
      }
    }
  }
  return out;
}

/** Adjudication references the gate re-reads. */
export function referencedSources(adjudication: unknown): SourceKey[] {
  const operations = (adjudication as { operations?: unknown } | null)
    ?.operations;
  if (!Array.isArray(operations)) return [];
  return citedSources([
    {
      findings: operations.map((op) => ({
        evidence: (op as { references?: unknown } | null)?.references,
      })),
    },
  ]);
}

/** A synchronous reader over a fetched set of sources. */
export function mapReader(texts: ReadonlyMap<string, string>): SourceReader {
  return (side, repoPath) => texts.get(keyOf(side, repoPath)) ?? null;
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

type TreeEntry = {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
};

/** The entries of one git tree (or of a commit's tree), `null` if unusable. */
function treeEntries(value: unknown): TreeEntry[] | null {
  const tree = field(value, 'tree');
  if (!Array.isArray(tree)) return null;
  return tree.filter(
    (entry): entry is TreeEntry =>
      typeof field(entry, 'path') === 'string' &&
      typeof field(entry, 'mode') === 'string' &&
      typeof field(entry, 'type') === 'string' &&
      typeof field(entry, 'sha') === 'string',
  );
}

const REGULAR_FILE = new Set(['100644', '100755']);
const OBJECT_ID = /^[0-9a-f]{40,64}$/u;

/**
 * Fetch each source the way the local git reader does, through the git
 * database API at the side's SHA (RIGHT = head, LEFT = merge base): walk
 * the trees one path component at a time (`GET /git/trees/{sha}`, cached),
 * require every parent to be a tree (mode 040000) and the entry to be a
 * regular blob (mode 100644 or 100755), then read it with `GET
 * /git/blobs/{sha}`. A symlink (mode 120000), submodule or directory reads
 * as missing; the contents API is not used because it serves a symlink to
 * an in-repository file as that file's content (live 2026-10-25).
 */
export async function fetchSources(input: {
  github: GithubClient;
  repository: string;
  shas: { RIGHT: string; LEFT: string };
  wanted: readonly SourceKey[];
}): Promise<Map<string, string>> {
  if (!isSha(input.shas.RIGHT) || !isSha(input.shas.LEFT))
    contractError('E_REVIEW_INPUT', 'source SHAs must be full SHAs');
  const repo = repositoryPath(input.repository);
  const trees = new Map<string, TreeEntry[] | null>();
  const tree = async (sha: string): Promise<TreeEntry[] | null> => {
    if (!trees.has(sha))
      trees.set(
        sha,
        treeEntries(
          await input.github.json(
            { method: 'GET', path: `${repo}/git/trees/${sha}` },
            [200, 404, 409, 422],
          ),
        ),
      );
    return trees.get(sha) ?? null;
  };
  const texts = new Map<string, string>();
  for (const { side, path: repoPath } of input.wanted.slice(
    0,
    SOURCE_LIMITS.sources,
  )) {
    if (!isRepoPath(repoPath)) continue;
    const parts = repoPath.split('/');
    let treeish = input.shas[side];
    let entry: TreeEntry | undefined;
    for (const [index, part] of parts.entries()) {
      const found = (await tree(treeish))?.find((e) => e.path === part);
      if (found === undefined || !OBJECT_ID.test(found.sha)) {
        entry = undefined;
        break;
      }
      if (index < parts.length - 1) {
        if (found.type !== 'tree' || found.mode !== '040000') {
          entry = undefined;
          break;
        }
        treeish = found.sha;
      } else {
        entry = found;
      }
    }
    if (
      entry === undefined ||
      entry.type !== 'blob' ||
      !REGULAR_FILE.has(entry.mode) ||
      typeof entry.size !== 'number' ||
      entry.size > SOURCE_LIMITS.fileBytes
    )
      continue;
    const blob = await input.github.json(
      { method: 'GET', path: `${repo}/git/blobs/${entry.sha}` },
      [200, 404],
    );
    const content = field(blob, 'content');
    if (field(blob, 'encoding') !== 'base64' || typeof content !== 'string')
      continue;
    const bytes = Buffer.from(content, 'base64');
    if (bytes.length !== entry.size) continue;
    texts.set(keyOf(side, repoPath), bytes.toString('utf8'));
  }
  return texts;
}

/** Run git in `repository` with agent-ci's neutralizing settings. */
function gitOutput(repository: string, args: readonly string[], git: string) {
  return execFileSync(git, safeGitArgs(args), {
    cwd: repository,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...SAFE_GIT_ENV },
    maxBuffer: SOURCE_LIMITS.fileBytes + 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * A reader over a local repository's object store: `ls-tree` must name a
 * regular blob (mode 100644 or 100755) at `<sha>:<path>`, then `cat-file
 * blob` reads it. Used by local `agent-ci review run`.
 */
export function gitSourceReader(
  repository: string,
  shas: { RIGHT: string; LEFT: string },
  git = 'git',
): SourceReader {
  if (!isSha(shas.RIGHT) || !isSha(shas.LEFT))
    contractError('E_REVIEW_INPUT', 'source SHAs must be full SHAs');
  const cache = new Map<string, string | null>();
  return (side, repoPath) => {
    if (!isRepoPath(repoPath)) return null;
    const key = keyOf(side, repoPath);
    if (cache.has(key)) return cache.get(key) ?? null;
    let text: string | null = null;
    try {
      const listing = gitOutput(
        repository,
        ['ls-tree', '-z', '--full-tree', shas[side], '--', repoPath],
        git,
      ).toString('utf8');
      const entry = listing.split('\u0000').find(Boolean) ?? '';
      const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.*)$/su.exec(
        entry,
      );
      if (match !== null && match[3] === repoPath) {
        const blob = gitOutput(
          repository,
          ['cat-file', 'blob', match[2] ?? ''],
          git,
        );
        if (blob.length <= SOURCE_LIMITS.fileBytes)
          text = blob.toString('utf8');
      }
    } catch {
      text = null;
    }
    cache.set(key, text);
    return text;
  };
}

/** Write fetched sources as a snapshot directory (index plus one file each). */
export async function writeSourceSnapshot(
  dir: string,
  texts: ReadonlyMap<string, string>,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const index: { side: Side; path: string; file: string }[] = [];
  let n = 0;
  for (const [key, text] of texts) {
    const [side, repoPath] = key.split('\u0000') as [Side, string];
    n += 1;
    const file = `S${n}.txt`;
    await writeFile(path.join(dir, file), text, { flag: 'wx' });
    index.push({ side, path: repoPath, file });
  }
  await writeFile(
    path.join(dir, 'index.json'),
    `${JSON.stringify(index, null, 2)}\n`,
    { flag: 'wx' },
  );
}

/** Read a snapshot written by {@link writeSourceSnapshot} (untrusted). */
export async function readSourceSnapshot(dir: string): Promise<SourceReader> {
  const indexText = await readArtifactFile(
    path.join(dir, 'index.json'),
    1024 * 1024,
  );
  let index: unknown = [];
  try {
    index = indexText === null ? [] : JSON.parse(indexText);
  } catch {
    index = [];
  }
  const texts = new Map<string, string>();
  for (const entry of Array.isArray(index)
    ? index.slice(0, SOURCE_LIMITS.sources)
    : []) {
    const side = field(entry, 'side');
    const repoPath = field(entry, 'path');
    const file = field(entry, 'file');
    if (
      (side !== 'RIGHT' && side !== 'LEFT') ||
      !isRepoPath(repoPath) ||
      typeof file !== 'string' ||
      !/^S[0-9]{1,4}\.txt$/u.test(file)
    )
      continue;
    const text = await readArtifactFile(
      path.join(dir, file),
      SOURCE_LIMITS.fileBytes,
    );
    if (text !== null) texts.set(keyOf(side, repoPath), text);
  }
  return mapReader(texts);
}

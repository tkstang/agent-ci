import type { PrRunRequest } from '@agent-ci/pr-run/request.js';
import { isSafeRepoPath } from '@agent-ci/publish/changes.js';
import type { GitRunner } from '@agent-ci/publish/git.js';
import { failure, success, type Result } from '@agent-ci/result.js';

export interface PrMerge {
  readonly tree: string;
  readonly mergeParent: string | null;
  readonly conflictedPaths: readonly string[];
}

const SHA = /^[0-9a-f]{40}$/u;
const MAX_CONFLICT_BYTES = 10 * 1024 * 1024;

/**
 * Compute the same merge in the agent, verification and publishing jobs.
 * Only a conflicting base is merged: clean base updates are left alone.
 * No index, checkout or ref is changed. Configured merge drivers are
 * disabled before merge-tree can run them.
 */
export async function computePrMerge(
  git: GitRunner,
  request: Pick<PrRunRequest, 'headSha' | 'baseSha'>,
): Promise<Result<PrMerge>> {
  if (!SHA.test(request.headSha) || !SHA.test(request.baseSha)) {
    return failure('E_PR_RUN_REQUEST', 'invalid pinned pull request commits');
  }
  const config = await git([
    'config',
    '--null',
    '--get-regexp',
    '^merge\\..*\\.driver$',
  ]);
  if (config.code !== 0 && config.code !== 1) {
    return failure(
      'E_PR_RUN_FAILED',
      'cannot inspect configured merge drivers',
    );
  }
  const overrides: string[] = [];
  for (const record of config.stdout.split('\0').filter(Boolean)) {
    const key = record.split('\n')[0] ?? '';
    if (key.includes('\0') || !/^merge\.[^\r\n=]+\.driver$/u.test(key)) {
      return failure('E_PR_RUN_FAILED', 'invalid configured merge driver');
    }
    overrides.push('-c', `${key}=false`);
  }
  const merge = await git([
    ...overrides,
    '-c',
    'merge.conflictStyle=merge',
    '-c',
    'merge.renormalize=false',
    '-c',
    'rerere.enabled=false',
    'merge-tree',
    '--write-tree',
    '--name-only',
    '--no-messages',
    '-z',
    request.headSha,
    request.baseSha,
  ]);
  if (merge.code !== 0 && merge.code !== 1) {
    return failure(
      'E_PR_RUN_FAILED',
      'cannot compute pull request merge; fetch both pinned commits and their history',
    );
  }
  const [tree = '', ...parts] = merge.stdout.split('\0');
  if (!SHA.test(tree)) {
    return failure('E_PR_RUN_FAILED', 'merge-tree returned an invalid tree');
  }
  if (merge.code === 0) {
    const head = await git(['rev-parse', `${request.headSha}^{tree}`]);
    const headTree = head.stdout.trim();
    return head.code === 0 && SHA.test(headTree)
      ? success({ tree: headTree, mergeParent: null, conflictedPaths: [] })
      : failure('E_PR_RUN_FAILED', 'cannot read the pinned pull request tree');
  }
  const end = parts.indexOf('');
  const conflictedPaths = end < 0 ? parts : parts.slice(0, end);
  if (
    conflictedPaths.length === 0 ||
    conflictedPaths.length > 2_000 ||
    conflictedPaths.some((file) => !isSafeRepoPath(file))
  ) {
    return failure(
      'E_PR_RUN_FAILED',
      'merge-tree returned invalid conflict paths',
    );
  }
  for (const file of conflictedPaths) {
    // V1 handles textual content conflicts only. Delete/modify, symlink,
    // submodule and binary conflicts need an explicit unsupported result.
    for (const commit of [request.headSha, request.baseSha, tree]) {
      const entry = await git(['ls-tree', '-z', commit, '--', file]);
      if (
        entry.code !== 0 ||
        !/^100(?:644|755) blob [0-9a-f]{40}\t/u.test(entry.stdout)
      ) {
        return failure(
          'E_PR_RUN_FAILED',
          `unsupported non-text conflict at ${file}`,
        );
      }
      const size = await git(['cat-file', '-s', `${commit}:${file}`]);
      if (
        size.code !== 0 ||
        !/^\d+\s*$/u.test(size.stdout) ||
        Number(size.stdout.trim()) > MAX_CONFLICT_BYTES
      ) {
        return failure(
          'E_PR_RUN_FAILED',
          `conflict at ${file} exceeds the supported text size`,
        );
      }
      const content = await git(['cat-file', 'blob', `${commit}:${file}`]);
      if (content.code !== 0 || content.stdout.includes('\0')) {
        return failure(
          'E_PR_RUN_FAILED',
          `unsupported binary conflict at ${file}`,
        );
      }
      if (
        commit === tree &&
        (!new RegExp(`^<{7,} ${request.headSha}(?::.*)?$`, 'mu').test(
          content.stdout,
        ) ||
          !new RegExp(`^>{7,} ${request.baseSha}(?::.*)?$`, 'mu').test(
            content.stdout,
          ))
      ) {
        return failure(
          'E_PR_RUN_FAILED',
          `unsupported conflict without textual merge markers at ${file}`,
        );
      }
    }
  }
  return success({ tree, mergeParent: request.baseSha, conflictedPaths });
}

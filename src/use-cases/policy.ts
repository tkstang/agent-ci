/**
 * Changed-path policies for the use-case wrappers, after pntr's
 * `quality_change_policy` (voxmedia/pntr@e438668). The publish job, which
 * holds write authority and runs no agent, checks every path of the change
 * set against the wrapper's policy before anything is pushed, so a prompt
 * injection that edits source, CI or skill files is refused instead of
 * published.
 *
 * A path is allowed when no deny prefix matches it and at least one allow
 * rule does: an exact path, a path prefix, a directory segment at any depth,
 * a file extension, or a file basename. Deny prefixes compare
 * case-insensitively (refusing more is the safe side); allow rules compare
 * exactly.
 */

export interface PathPolicy {
  /** Exact repository-relative paths. */
  readonly exact: readonly string[];
  /** Path prefixes (directories end in `/`). */
  readonly prefixes: readonly string[];
  /** Prefixes refused even when an allow rule matches. */
  readonly denyPrefixes: readonly string[];
  /** Directory names that allow everything below them, at any depth. */
  readonly segments: readonly string[];
  /** File extensions, with the dot (`.md`). */
  readonly extensions: readonly string[];
  /** File names allowed in any directory (`AGENTS.md`). */
  readonly basenames: readonly string[];
}

export const EMPTY_POLICY: PathPolicy = Object.freeze({
  exact: [],
  prefixes: [],
  denyPrefixes: [],
  segments: [],
  extensions: [],
  basenames: [],
});

/** True when `file` (repository-relative, `/`-separated) passes the policy. */
export function isAllowedPath(file: string, policy: PathPolicy): boolean {
  const lower = file.toLowerCase();
  if (
    policy.denyPrefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()))
  )
    return false;
  if (policy.exact.includes(file)) return true;
  if (policy.prefixes.some((prefix) => file.startsWith(prefix))) return true;
  const parts = file.split('/');
  const basename = parts.at(-1) ?? '';
  if (parts.slice(0, -1).some((part) => policy.segments.includes(part)))
    return true;
  if (policy.basenames.includes(basename)) return true;
  return policy.extensions.some(
    (extension) =>
      basename.length > extension.length && basename.endsWith(extension),
  );
}

/** The paths the policy refuses, sorted. */
export function findDisallowedPaths(
  files: readonly string[],
  policy: PathPolicy,
): string[] {
  return [...new Set(files)]
    .filter((file) => !isAllowedPath(file, policy))
    .toSorted();
}

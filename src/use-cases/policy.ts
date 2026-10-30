/**
 * Changed-path policies for the use-case wrappers. The publish job, which
 * holds write authority and runs no agent, checks every entry of the change
 * set against the wrapper's policy before anything is pushed, so a prompt
 * injection that edits source, CI, agent configuration or skill files is
 * refused instead of published.
 *
 * An entry passes when no deny rule matches its path, at least one allow
 * rule does, and its kind is allowed: an executable file or a symlink passes
 * only a policy that allows them. Deny rules match case-insensitively
 * (refusing more is the safe side); allow rules match exactly. Rules are
 * anchored regular expressions over the repository-relative path.
 */

export interface PathPolicy {
  /** A path must match at least one. */
  readonly allow: readonly RegExp[];
  /** A path matching any is refused, whatever the allow rules say. */
  readonly deny: readonly RegExp[];
  /** Whether a file may be written with mode 100755. */
  readonly executables: boolean;
  /** Whether the change set may create or change a symlink. */
  readonly symlinks: boolean;
}

export const EMPTY_POLICY: PathPolicy = Object.freeze({
  allow: [],
  deny: [],
  executables: false,
  symlinks: false,
});

/** True when `file` (repository-relative, `/`-separated) passes the policy's path rules. */
export function isAllowedPath(file: string, policy: PathPolicy): boolean {
  const lower = file.toLowerCase();
  if (policy.deny.some((rule) => rule.test(lower))) return false;
  return policy.allow.some((rule) => rule.test(file));
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

/**
 * What a policy needs to know about one changed path: a change-set entry, or
 * one path of a pull request diff (where a submodule pointer can appear).
 */
export type PolicyEntry =
  | {
      readonly path: string;
      readonly action: 'write';
      readonly mode: string;
    }
  | { readonly path: string; readonly action: 'symlink' | 'delete' }
  | { readonly path: string; readonly action: 'submodule' };

/** Entries the policy refuses (by path or by kind), as `path (reason)`. */
export function findPolicyViolations(
  entries: readonly PolicyEntry[],
  policy: PathPolicy,
): string[] {
  const refused: string[] = [];
  for (const entry of entries) {
    if (!isAllowedPath(entry.path, policy)) {
      refused.push(entry.path);
    } else if (entry.action === 'submodule') {
      // No policy allows a submodule pointer.
      refused.push(`${entry.path} (submodule)`);
    } else if (entry.action === 'symlink' && !policy.symlinks) {
      refused.push(`${entry.path} (symlink)`);
    } else if (
      entry.action === 'write' &&
      entry.mode !== '100644' &&
      !policy.executables
    ) {
      refused.push(`${entry.path} (executable)`);
    }
  }
  return refused.toSorted();
}

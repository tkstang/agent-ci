import {
  contractError,
  type DiffPosition,
  isRepoPath,
  type Side,
  splitLines,
} from '@agent-ci/review/contracts.js';

/**
 * Unified-diff parsing and side-specific anchor resolution for PR review,
 * ported from pntr's `pntr-pr-review/diff-position.ts`
 * (voxmedia/pntr@e438668).
 *
 * The diff is GitHub's three-dot PR diff for the captured SHAs: its old side
 * is the merge-base tree and its new side is the head tree. A cited range is
 * anchorable only when every line sits in one complete hunk on the cited side
 * and the hunk text agrees with that side's tree (snapshot consistency).
 */

export type DiffLine = {
  kind: 'context' | 'add' | 'del';
  oldLine: number | null;
  newLine: number | null;
  /** Line text without the diff prefix or a trailing CR. */
  text: string;
};
export type DiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
  /** False when the diff ended before the hunk's declared line counts. */
  complete: boolean;
};
export type DiffFileStatus =
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'modified';
export type DiffFile = {
  /** Merge-base path; `null` for an added file. */
  oldPath: string | null;
  /** Head path; `null` for a deleted file. */
  newPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  hunks: DiffHunk[];
  /** False when truncation may have cut this file's hunks. */
  complete: boolean;
};
export type ParsedDiff = { files: DiffFile[]; truncated: boolean };
/** Reads a file from the head (`RIGHT`) or merge-base (`LEFT`) tree. */
export type SourceReader = (side: Side, path: string) => string | null;
export type AnchorRequest = {
  path: string;
  side: Side;
  line: number;
  end_line: number;
};
export type AnchorResult =
  | {
      ok: true;
      position: DiffPosition;
      /** Path of the cited side's tree (old path for LEFT). */
      sourcePath: string;
      /** Trusted source lines at the range, LF-joined. */
      code: string;
      /** Full text of the cited side's file. */
      source: string;
    }
  | { ok: false; reason: AnchorFailure };
export type AnchorFailure =
  | 'anchor_not_in_diff'
  | 'anchor_binary'
  | 'anchor_side_absent'
  | 'anchor_outside_hunk'
  | 'anchor_crosses_hunks'
  | 'anchor_truncated'
  | 'anchor_source_missing'
  | 'anchor_snapshot_mismatch';

function invalidDiff(message: string): never {
  return contractError('E_INVALID_DIFF', message);
}

const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};
/**
 * Parse a git C-style quoted path starting at `value[0] === '"'`. Returns
 * the decoded path and the remaining text after the closing quote.
 */
function unquote(value: string): { path: string; rest: string } {
  const bytes: number[] = [];
  let index = 1;
  while (index < value.length) {
    const character = value[index]!;
    if (character === '"')
      return {
        path: new TextDecoder('utf-8', { fatal: true }).decode(
          Uint8Array.from(bytes),
        ),
        rest: value.slice(index + 1),
      };
    if (character === '\\') {
      const next = value[index + 1] ?? '';
      const octal = /^[0-7]{3}/u.exec(value.slice(index + 1));
      if (octal) {
        bytes.push(Number.parseInt(octal[0], 8));
        index += 4;
        continue;
      }
      if (!(next in ESCAPES)) invalidDiff('invalid quoted path escape');
      bytes.push(ESCAPES[next]!);
      index += 2;
      continue;
    }
    bytes.push(...Buffer.from(character, 'utf8'));
    index += 1;
  }
  return invalidDiff('unterminated quoted path');
}
/** Strip the `a/` or `b/` prefix from a `---`/`+++` path; `null` for /dev/null. */
function prefixed(raw: string, prefix: 'a/' | 'b/'): string | null {
  const value = raw.replace(/\t.*$/u, '');
  if (value === '/dev/null') return null;
  const decoded = value.startsWith('"') ? unquote(value).path : value;
  if (!decoded.startsWith(prefix))
    invalidDiff('diff path lacks a/ or b/ prefix');
  const path = decoded.slice(2);
  if (!isRepoPath(path)) invalidDiff('unsafe diff path');
  return path;
}
function plain(raw: string): string {
  const path = raw.startsWith('"') ? unquote(raw).path : raw;
  if (!isRepoPath(path)) invalidDiff('unsafe diff path');
  return path;
}
/** Paths from `diff --git a/X b/Y` (used when no ---/+++ lines follow). */
function headerPaths(rest: string): { oldPath: string; newPath: string } {
  if (rest.startsWith('"')) {
    const first = unquote(rest);
    const second = first.rest.trimStart();
    const newRaw = second.startsWith('"') ? unquote(second).path : second;
    const oldPath = first.path;
    if (!oldPath.startsWith('a/') || !newRaw.startsWith('b/'))
      invalidDiff('diff header lacks a/ or b/ prefix');
    return {
      oldPath: plain(oldPath.slice(2)),
      newPath: plain(newRaw.slice(2)),
    };
  }
  // Unquoted `a/P b/P` with identical paths: the split point is unambiguous.
  const length = (rest.length - 5) / 2;
  const oldPath = rest.slice(2, 2 + length);
  if (
    !Number.isInteger(length) ||
    !rest.startsWith('a/') ||
    rest.slice(2 + length, 5 + length) !== ' b/' ||
    rest.slice(5 + length) !== oldPath
  )
    invalidDiff('ambiguous diff header paths');
  return { oldPath: plain(oldPath), newPath: plain(oldPath) };
}

// Extended headers that carry no anchor data.
const EXTENDED_HEADER =
  /^(index [0-9a-f]+\.\.[0-9a-f]+( [0-7]+)?|old mode [0-7]+|new mode [0-7]+|(dis)?similarity index \d+%)$/u;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

type Building = {
  header: { oldPath: string; newPath: string } | null;
  headerRest: string;
  minus?: string | null;
  plus?: string | null;
  renameFrom?: string;
  renameTo?: string;
  copyFrom?: string;
  copyTo?: string;
  added: boolean;
  deleted: boolean;
  binary: boolean;
  modeChange: boolean;
  /** Blob ids from the `index` line, when present. */
  index?: { from: string; to: string };
  hunks: DiffHunk[];
};

// Abbreviated ids of the empty blob (SHA-1 and SHA-256 repositories) and
// the all-zero id of a missing side.
const EMPTY_BLOBS = [
  'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
  '473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813',
];
const isEmptyBlob = (id: string) =>
  /^0+$/u.test(id) || EMPTY_BLOBS.some((blob) => blob.startsWith(id));

/**
 * True when a file section ends before content its headers promise: a
 * `---` without its `+++`, path headers without a hunk, a content change
 * (`index` line) with neither hunks nor a binary marker, or a section with
 * no header beyond `diff --git`. Mode-only, empty-file, binary and pure
 * rename or copy sections are complete without hunks.
 */
function headerIncomplete(file: Building): boolean {
  if (file.binary) return false;
  const textual = file.minus !== undefined || file.plus !== undefined;
  if (textual)
    return (
      file.minus === undefined ||
      file.plus === undefined ||
      file.hunks.length === 0
    );
  if (file.index) {
    // Without hunks, an index line is complete only for an empty file
    // being added or deleted.
    const { from, to } = file.index;
    return !(
      (file.added && isEmptyBlob(to)) ||
      (file.deleted && isEmptyBlob(from))
    );
  }
  return !(file.modeChange || file.renameFrom || file.copyFrom);
}

function finish(file: Building): DiffFile {
  let oldPath: string | null;
  let newPath: string | null;
  if (file.minus !== undefined && file.plus !== undefined) {
    oldPath = file.minus;
    newPath = file.plus;
  } else if (file.minus !== undefined || file.plus !== undefined) {
    // An unfinished header pair (cut before `+++`): keep the known path on
    // both sides; the section is marked incomplete below.
    oldPath = file.minus ?? file.plus ?? null;
    newPath = oldPath;
  } else if (file.renameFrom || file.copyFrom) {
    oldPath = file.renameFrom ?? file.copyFrom ?? null;
    newPath = file.renameTo ?? file.copyTo ?? null;
  } else {
    const paths = headerPaths(file.headerRest);
    oldPath = file.added ? null : paths.oldPath;
    newPath = file.deleted ? null : paths.newPath;
  }
  if (file.added) oldPath = null;
  if (file.deleted) newPath = null;
  if (oldPath === null && newPath === null)
    invalidDiff('diff file has no path');
  const status: DiffFileStatus =
    oldPath === null
      ? 'added'
      : newPath === null
        ? 'deleted'
        : file.renameFrom
          ? 'renamed'
          : file.copyFrom
            ? 'copied'
            : oldPath !== newPath
              ? 'renamed'
              : 'modified';
  return {
    oldPath,
    newPath,
    status,
    binary: file.binary,
    hunks: file.hunks,
    complete:
      !headerIncomplete(file) && file.hunks.every((hunk) => hunk.complete),
  };
}

/**
 * Parse a git-format unified diff. `truncated` is the caller's signal that
 * the diff response was cut; the last file is then treated as incomplete.
 * A hunk cut short by the end of input, or a file section whose headers
 * end before the content they promise, also marks the diff truncated.
 */
export function parseUnifiedDiff(
  text: string,
  options: { truncated?: boolean } = {},
): ParsedDiff {
  const files: DiffFile[] = [];
  let current: Building | null = null;
  let hunk: DiffHunk | null = null;
  let oldNext = 0;
  let newNext = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let inBinaryPatch = false;
  // Header and hunk lines both drop a trailing CR; trees are compared in LF form.
  const lines = text.split('\n').map((line) => line.replace(/\r$/u, ''));
  if (lines.at(-1) === '') lines.pop();
  const closeHunk = () => {
    if (hunk) hunk.complete = oldLeft === 0 && newLeft === 0;
    hunk = null;
  };
  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      closeHunk();
      if (current) files.push(finish(current));
      current = {
        header: null,
        headerRest: raw.slice('diff --git '.length),
        added: false,
        deleted: false,
        binary: false,
        modeChange: false,
        hunks: [],
      };
      inBinaryPatch = false;
      continue;
    }
    if (!current) {
      if (raw.trim() === '') continue;
      invalidDiff('diff content before the first file header');
    }
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const marker = raw[0] ?? ' ';
      const body = raw.slice(1);
      if (raw.startsWith('\\')) continue;
      if (marker === ' ' || raw === '') {
        if (oldLeft === 0 || newLeft === 0)
          invalidDiff('hunk context exceeds its declared counts');
        hunk.lines.push({
          kind: 'context',
          oldLine: oldNext++,
          newLine: newNext++,
          text: body,
        });
        oldLeft -= 1;
        newLeft -= 1;
      } else if (marker === '-') {
        if (oldLeft === 0) invalidDiff('hunk deletions exceed declared count');
        hunk.lines.push({
          kind: 'del',
          oldLine: oldNext++,
          newLine: null,
          text: body,
        });
        oldLeft -= 1;
      } else if (marker === '+') {
        if (newLeft === 0) invalidDiff('hunk additions exceed declared count');
        hunk.lines.push({
          kind: 'add',
          oldLine: null,
          newLine: newNext++,
          text: body,
        });
        newLeft -= 1;
      } else invalidDiff('unexpected line inside a hunk');
      continue;
    }
    if (raw.startsWith('\\')) continue;
    const header = HUNK.exec(raw);
    if (header) {
      closeHunk();
      const [, oldStart, oldCount, newStart, newCount] = header;
      hunk = {
        oldStart: Number(oldStart),
        oldCount: oldCount === undefined ? 1 : Number(oldCount),
        newStart: Number(newStart),
        newCount: newCount === undefined ? 1 : Number(newCount),
        lines: [],
        complete: false,
      };
      // A zero-count side's start names the line before the (empty) range.
      oldNext = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
      newNext = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
      oldLeft = hunk.oldCount;
      newLeft = hunk.newCount;
      current.hunks.push(hunk);
      continue;
    }
    if (hunk) closeHunk();
    if (inBinaryPatch) continue;
    // Once hunks begin, only further hunks may follow; stray content is not
    // silently dropped.
    if (current.hunks.length > 0) invalidDiff('content outside a hunk');
    if (raw.startsWith('--- ')) current.minus = prefixed(raw.slice(4), 'a/');
    else if (raw.startsWith('+++ '))
      current.plus = prefixed(raw.slice(4), 'b/');
    else if (raw.startsWith('new file mode')) current.added = true;
    else if (raw.startsWith('deleted file mode')) current.deleted = true;
    else if (raw.startsWith('rename from '))
      current.renameFrom = plain(raw.slice(12));
    else if (raw.startsWith('rename to '))
      current.renameTo = plain(raw.slice(10));
    else if (raw.startsWith('copy from '))
      current.copyFrom = plain(raw.slice(10));
    else if (raw.startsWith('copy to ')) current.copyTo = plain(raw.slice(8));
    else if (/^Binary files .* differ$/u.test(raw)) current.binary = true;
    else if (raw === 'GIT binary patch') {
      current.binary = true;
      inBinaryPatch = true;
    } else if (!EXTENDED_HEADER.test(raw))
      invalidDiff('unrecognized diff header line');
    else if (raw.startsWith('index ')) {
      const [from, to] = raw.slice(6).split(' ')[0]!.split('..');
      current.index = { from: from!, to: to! };
    } else if (raw.startsWith('old mode') || raw.startsWith('new mode'))
      current.modeChange = true;
  }
  closeHunk();
  if (current) files.push(finish(current));
  let truncated = options.truncated === true;
  if (files.some((file) => !file.complete)) truncated = true;
  if (options.truncated === true && files.length > 0)
    files[files.length - 1]!.complete = false;
  return { files, truncated };
}

function findFile(
  diff: ParsedDiff,
  path: string,
  side: Side,
): DiffFile | undefined {
  if (side === 'RIGHT') return diff.files.find((file) => file.newPath === path);
  return (
    diff.files.find((file) => file.oldPath === path) ??
    diff.files.find((file) => file.newPath === path)
  );
}

/**
 * Resolve a cited range to a GitHub review-comment position. RIGHT lines are
 * checked against the head tree and LEFT lines against the merge-base tree.
 */
export function resolveAnchor(
  diff: ParsedDiff,
  request: AnchorRequest,
  read: SourceReader,
): AnchorResult {
  const file = findFile(diff, request.path, request.side);
  if (!file) return { ok: false, reason: 'anchor_not_in_diff' };
  if (file.binary) return { ok: false, reason: 'anchor_binary' };
  const sourcePath = request.side === 'RIGHT' ? file.newPath : file.oldPath;
  if (sourcePath === null) return { ok: false, reason: 'anchor_side_absent' };
  const sideLine = (line: DiffLine) =>
    request.side === 'RIGHT' ? line.newLine : line.oldLine;
  const containing = (number: number) =>
    file.hunks.find((h) => h.lines.some((line) => sideLine(line) === number));
  const hunk = containing(request.line);
  if (!hunk) return { ok: false, reason: 'anchor_outside_hunk' };
  const byNumber = new Map<number, DiffLine>();
  for (const line of hunk.lines) {
    const number = sideLine(line);
    if (number !== null) byNumber.set(number, line);
  }
  // GitHub rejects a multi-line comment whose range spans hunks.
  for (let number = request.line; number <= request.end_line; number += 1)
    if (!byNumber.has(number)) {
      const endHunk = containing(request.end_line);
      return {
        ok: false,
        reason:
          endHunk && endHunk !== hunk
            ? 'anchor_crosses_hunks'
            : 'anchor_outside_hunk',
      };
    }
  if (!hunk.complete) return { ok: false, reason: 'anchor_truncated' };
  const source = read(request.side, sourcePath);
  if (source === null) return { ok: false, reason: 'anchor_source_missing' };
  const tree = splitLines(source);
  for (let number = request.line; number <= request.end_line; number += 1)
    if (tree[number - 1] !== byNumber.get(number)!.text)
      return { ok: false, reason: 'anchor_snapshot_mismatch' };
  return {
    ok: true,
    position: {
      path: file.newPath ?? sourcePath,
      side: request.side,
      line: request.end_line,
      start_line: request.end_line > request.line ? request.line : null,
    },
    sourcePath,
    code: tree.slice(request.line - 1, request.end_line).join('\n'),
    source,
  };
}

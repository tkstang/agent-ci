import {
  type Category,
  isRepoPath,
  RULE_SENTINEL,
  sha256,
  splitLines,
} from '@agent-ci/review/contracts.js';

/**
 * Finding identity for dedupe across passes and reruns, ported from pntr's
 * `pntr-pr-review/fingerprint.ts` (voxmedia/pntr@e438668). A fingerprint never
 * includes the model's title or a line number, so rewording and unrelated
 * line shifts keep it stable. It hashes the path, the conservatively
 * normalized trusted source at the anchor, the category, a verified
 * canonical rule id (or {@link RULE_SENTINEL}), and an occurrence
 * discriminator that separates identical snippets in one file.
 */

const FINGERPRINT_VERSION = 'agent-ci-pr-review/fingerprint/v1';

/**
 * Conservative code normalization: LF line endings, each line trimmed with
 * inner whitespace runs collapsed, and leading/trailing blank lines dropped.
 * Tokens, punctuation and line structure are otherwise preserved.
 */
export function normalizeCode(code: string): string {
  const lines = code.replace(/\r\n?/gu, '\n').split('\n').map(normalizeLine);
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}
function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/gu, ' ');
}

/**
 * Narrow a cited range past blank edge lines, so identity is computed over
 * the code it actually flags. An all-blank range keeps its first line.
 */
function trimRange(
  normalized: readonly string[],
  line: number,
  endLine: number,
): { line: number; endLine: number } {
  let first = line;
  let last = endLine;
  while (first < last && normalized[first - 1] === '') first += 1;
  while (last > first && normalized[last - 1] === '') last -= 1;
  return { line: first, endLine: last };
}

/**
 * A scope header is a line that starts in column one with a letter, `_` or
 * `$` (git's default hunk-header rule): top-level declarations in most
 * languages.
 */
const DECLARATION = /^[A-Za-z_$]/u;

/**
 * Occurrence discriminator for the snippet at `range` (1-based, blank edge
 * lines already trimmed with `trimRange`) of the source lines: the normalized
 * nearest preceding declaration line (its scope header) plus the snippet's
 * ordinal among identical (normalized) occurrences that start earlier in
 * the file in any scope with the same normalized header. Scopes whose
 * headers normalize identically (two `impl Foo {` blocks, repeated
 * `namespace {` blocks) therefore count as one scope, so two occurrences
 * whose trimmed ranges start on different lines never share an identity.
 * Unrelated lines inserted elsewhere, or inside a scope without repeating
 * the snippet or its header, leave it unchanged.
 *
 * Each line is normalized once and occurrences are found by exact
 * Knuth-Morris-Pratt matching over normalized-line ids, so the cost is
 * linear in the file and range length, whatever the agent cites.
 */
function discriminate(
  raw: readonly string[],
  normalized: readonly string[],
  range: { line: number; endLine: number },
): string {
  const start = range.line - 1;
  const length = range.endLine - range.line + 1;
  // headers[i] is the normalized declaration nearest before line index i.
  const headers: string[] = [];
  let current = '';
  for (let index = 0; index <= start && index <= raw.length; index += 1) {
    headers.push(current);
    const text = raw[index];
    if (text !== undefined && DECLARATION.test(text))
      current = normalized[index]!;
  }
  const header = headers[start] ?? current;
  // Exact matching over integer ids of normalized lines.
  const ids = new Map<string, number>();
  const idOf = (text: string) => {
    let id = ids.get(text);
    if (id === undefined) ids.set(text, (id = ids.size));
    return id;
  };
  const end = Math.min(normalized.length, start + length);
  const text = normalized.slice(0, end).map(idOf);
  const pattern = text.slice(start, start + length);
  let ordinal = 0;
  if (pattern.length === length && length > 0) {
    const failure = Array.from<number>({ length }).fill(0);
    for (let i = 1, k = 0; i < length; i += 1) {
      while (k > 0 && pattern[i] !== pattern[k]) k = failure[k - 1]!;
      if (pattern[i] === pattern[k]) k += 1;
      failure[i] = k;
    }
    // A match ending at index `i` starts at `i - length + 1`; count those
    // starting before the snippet under the same header.
    for (let i = 0, k = 0; i < start + length - 1; i += 1) {
      while (k > 0 && text[i] !== pattern[k]) k = failure[k - 1]!;
      if (text[i] === pattern[k]) k += 1;
      if (k === length) {
        const begin = i - length + 1;
        if (headers[begin] === header) ordinal += 1;
        k = failure[k - 1]!;
      }
    }
  }
  return sha256(JSON.stringify([FINGERPRINT_VERSION, header, ordinal]));
}

/** GitHub-style heading slugs, with `-N` suffixes for repeated headings. */
function headingSlugs(source: string): Set<string> {
  const slugs = new Set<string>();
  const seen = new Map<string, number>();
  let fence: string | null = null;
  for (const line of splitLines(source)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/u.exec(line);
    if (!heading) continue;
    const base = heading[1]!
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s/gu, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

const RULE_FILE = /\.(md|mdc|mdx)$/iu;

/**
 * Canonicalize an agent-supplied `rule_id` against the head tree. Returns
 * `path` or `path#anchor` when the markdown rule file exists at the PR head
 * and the optional anchor names one of its headings; otherwise `null`, and
 * the fingerprint uses {@link RULE_SENTINEL}.
 */
export function canonicalRuleId(
  ruleId: string | null,
  readHead: (path: string) => string | null,
): string | null {
  if (ruleId === null) return null;
  const hash = ruleId.indexOf('#');
  let path = hash < 0 ? ruleId : ruleId.slice(0, hash);
  const anchor = hash < 0 ? null : ruleId.slice(hash + 1).toLowerCase();
  while (path.startsWith('./')) path = path.slice(2);
  if (!isRepoPath(path) || !RULE_FILE.test(path)) return null;
  const source = readHead(path);
  if (source === null) return null;
  if (anchor === null) return path;
  if (anchor === '' || !headingSlugs(source).has(anchor)) return null;
  return `${path}#${anchor}`;
}

export type FindingIdentityInput = {
  /** GitHub review-comment path of the finding. */
  path: string;
  /** Full text of the cited side's file. */
  source: string;
  line: number;
  end_line: number;
  category: Category;
  /** Canonical rule id from {@link canonicalRuleId}, or `null`. */
  ruleId: string | null;
};
export type FindingIdentity = { fingerprint: string; discriminator: string };

/** Fingerprint and discriminator for a validated, anchored finding. */
export function findingIdentity(input: FindingIdentityInput): FindingIdentity {
  const raw = splitLines(input.source);
  const normalized = raw.map(normalizeLine);
  // Identity uses the cited range without blank edge lines; the GitHub
  // position keeps the agent's range.
  const range = trimRange(normalized, input.line, input.end_line);
  const discriminator = discriminate(raw, normalized, range);
  const code = raw.slice(range.line - 1, range.endLine).join('\n');
  const fingerprint = sha256(
    JSON.stringify([
      FINGERPRINT_VERSION,
      input.path,
      normalizeCode(code),
      input.category,
      input.ruleId ?? RULE_SENTINEL,
      discriminator,
    ]),
  );
  return { fingerprint, discriminator };
}

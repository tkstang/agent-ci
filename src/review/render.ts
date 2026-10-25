import {
  contractError,
  isBotLogin,
  isUserLogin,
  type GatedFinding,
  type GatedReview,
  type PostedMarker,
  type ReviewIdentity,
  type ReviewPass,
  SEVERITIES,
  type Severity,
  sha256,
  validateIdentity,
} from '@agent-ci/review/contracts.js';

/**
 * Review-specific rendering, ported from pntr's `pntr-pr-review/render.ts`
 * (voxmedia/pntr@e438668), separate from the generic run comment. Agent-
 * authored prose is sanitized; code is rendered byte-for-byte inside fences
 * it cannot close; markers are appended only here, as the final line, and
 * parsed back only from that position in comments by the validated
 * publisher identity.
 */

const MARKER_PREFIX = 'agent-ci-pr-review:v1';
const HEX64 = '[0-9a-f]{64}';
const FINDING_MARKER = new RegExp(
  `^<!-- ${MARKER_PREFIX} scope=(${HEX64}) fp=(${HEX64}) occ=(${HEX64}) -->$`,
  'u',
);
/**
 * Room for the explanations of findings GitHub rejected inline, so the
 * summary stays well inside GitHub's comment size limit; past it, findings
 * are still listed by title.
 */
export const REJECTED_DETAIL_BYTES = 32 * 1024;
const REJECTED_DETAIL_LINES = 40;
/** Heading of the 422 fallback's list (quoted by the publisher and docs). */
export const REJECTED_HEADING = 'Findings not posted inline';
/**
 * Most characters `renderSummary` returns: below GitHub's 65,536-character
 * comment limit, with room for the publisher's notes (price table, run
 * link, the 422 warning).
 */
export const SUMMARY_MAX_CHARS = 60_000;
/** Room kept for the shortened-summary note. */
const SUMMARY_NOTE_RESERVE = 300;
/** List entries show at most this many title characters. */
const LIST_TITLE_CODE_POINTS = 120;
function listTitle(title: string): string {
  const points = [...title];
  return sanitizeTitle(
    points.length > LIST_TITLE_CODE_POINTS
      ? `${points.slice(0, LIST_TITLE_CODE_POINTS).join('')}…`
      : title,
  );
}

/** Pass labels shown to readers; never derived from agent text. */
const PASS_LABELS: Record<ReviewPass | 'adjudicator', string> = {
  primary: 'primary reviewer',
  second: 'second reviewer',
  adjudicator: 'adjudicator',
};

/**
 * The validated identity whose comments may carry markers: the account the
 * publishing token acts as. `github-actions[bot]` (type `Bot`) for
 * `GITHUB_TOKEN`; a GitHub App bot; or, for a local `agent-ci review run`,
 * the operator's own login (type `User`).
 */
export type PublisherIdentity = { login: string; type: 'Bot' | 'User' };
/** The default publisher in GitHub Actions. */
export const ACTIONS_PUBLISHER: PublisherIdentity = Object.freeze({
  login: 'github-actions[bot]',
  type: 'Bot',
});
/** Usage for one pass as the harness reported it; unknowns are `null`. */
export type UsageRow = {
  pass: ReviewPass | 'adjudicator';
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  /** Cost the harness itself reported (Claude); `null` when it reported none. */
  reported_cost_usd: number | null;
  /** agent-ci's own notes on the pass (for example a shortened prompt). */
  notes?: string[];
};
/** One inline review comment for `POST /pulls/{n}/reviews`. */
export type ReviewComment = {
  path: string;
  body: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
};
export type ReviewPayload = {
  commit_id: string;
  event: 'COMMENT';
  body: string;
  comments: ReviewComment[];
};

/** Digest fixing the marker scope to repository, workflow, PR and scope. */
export function scopeDigest(identity: ReviewIdentity): string {
  const { repository, workflow, pr_number, scope } = validateIdentity(identity);
  return sha256(
    JSON.stringify([MARKER_PREFIX, repository, workflow, pr_number, scope]),
  );
}
export function findingMarker(
  identity: ReviewIdentity,
  marker: PostedMarker,
): string {
  if (
    !new RegExp(`^${HEX64}$`, 'u').test(marker.fingerprint) ||
    !new RegExp(`^${HEX64}$`, 'u').test(marker.discriminator)
  )
    contractError('E_REVIEW_INPUT', 'invalid finding marker');
  return `<!-- ${MARKER_PREFIX} scope=${scopeDigest(identity)} fp=${marker.fingerprint} occ=${marker.discriminator} -->`;
}
export function summaryMarker(identity: ReviewIdentity): string {
  return `<!-- ${MARKER_PREFIX} scope=${scopeDigest(identity)} summary -->`;
}
export function reviewMarker(identity: ReviewIdentity): string {
  return `<!-- ${MARKER_PREFIX} scope=${scopeDigest(identity)} review -->`;
}

type UntrustedComment = {
  id?: unknown;
  body?: unknown;
  user?: { login?: unknown; type?: unknown } | null;
};
export function assertPublisher(publisher: PublisherIdentity): void {
  const valid =
    publisher.type === 'Bot'
      ? isBotLogin(publisher.login)
      : publisher.type === 'User' && isUserLogin(publisher.login);
  if (!valid) contractError('E_REVIEW_INPUT', 'invalid publisher identity');
}
function fromPublisher(
  comment: UntrustedComment,
  publisher: PublisherIdentity,
): boolean {
  return (
    comment.user?.login === publisher.login &&
    comment.user?.type === publisher.type
  );
}
function lastLine(body: unknown): string | null {
  if (typeof body !== 'string') return null;
  const lines = body.replace(/\r\n?/gu, '\n').trimEnd().split('\n');
  return lines.at(-1) ?? null;
}

/**
 * Markers already posted for this scope. Only a comment by the validated
 * publisher identity counts, and only when its final line is an exact
 * marker for this scope; marker-like text anywhere else is ignored.
 */
export function parsePostedMarkers(
  comments: readonly unknown[],
  identity: ReviewIdentity,
  publisher: PublisherIdentity,
): PostedMarker[] {
  assertPublisher(publisher);
  const scope = scopeDigest(identity);
  const markers = new Map<string, PostedMarker>();
  for (const raw of comments) {
    const comment = (raw ?? {}) as UntrustedComment;
    if (!fromPublisher(comment, publisher)) continue;
    const match = FINDING_MARKER.exec(lastLine(comment.body) ?? '');
    if (!match || match[1] !== scope) continue;
    markers.set(`${match[2]}:${match[3]}`, {
      fingerprint: match[2]!,
      discriminator: match[3]!,
    });
  }
  return [...markers.values()];
}
/** True when `comment` is this scope's summary comment by the publisher. */
export function isSummaryComment(
  comment: unknown,
  identity: ReviewIdentity,
  publisher: PublisherIdentity,
): boolean {
  assertPublisher(publisher);
  const candidate = (comment ?? {}) as UntrustedComment;
  return (
    fromPublisher(candidate, publisher) &&
    lastLine(candidate.body) === summaryMarker(identity)
  );
}

/** Longest run of backticks in `text`. */
function longestBacktickRun(text: string): number {
  return Math.max(0, ...[...text.matchAll(/`+/gu)].map((m) => m[0].length));
}
/**
 * Fence `code` byte-for-byte (after LF normalization) with a backtick fence
 * longer than any backtick run inside it, so the code cannot close it.
 */
export function codeFence(code: string, info = ''): string {
  const body = code.replace(/\r\n?/gu, '\n').replace(/\n$/u, '');
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1));
  return `${fence}${info}\n${body}\n${fence}`;
}
function codeSpan(text: string): string {
  const content = text.replace(/[\r\n]+/gu, ' ');
  const delimiter = '`'.repeat(longestBacktickRun(content) + 1);
  return `${delimiter} ${content} ${delimiter}`;
}
function escapeText(text: string): string {
  return (
    text
      .replace(/&/gu, '&amp;')
      .replace(/</gu, '&lt;')
      .replace(/>/gu, '&gt;')
      // Backslash, backtick and tilde could open code spans or fences;
      // brackets could form links or images.
      .replace(/([\\`~[\]])/gu, '\\$1')
      // Fullwidth forms stay inert even if a renderer decodes entities
      // before linking mentions, references (`#12`, `owner/repo#12`,
      // `GH-12`) or bare URLs (`https://`, `www.`).
      .replace(/@/gu, '＠')
      .replace(/#(?=\d)/gu, '＃')
      .replace(/\b(GH)-(?=\d)/giu, '$1－')
      .replace(/:(?=\/\/)/gu, '：')
      .replace(/\b(www)\./giu, '$1．')
  );
}
/** Inline text with agent code spans re-emitted under our own delimiters. */
function sanitizeInline(text: string): string {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const open = /`+/u.exec(text.slice(index));
    if (!open) {
      output += escapeText(text.slice(index));
      break;
    }
    const start = index + open.index;
    const run = open[0].length;
    output += escapeText(text.slice(index, start));
    const after = start + run;
    const close = new RegExp(`(?<!\`)\`{${run}}(?!\`)`, 'u').exec(
      text.slice(after),
    );
    if (!close) {
      output += escapeText(open[0]);
      index = after;
      continue;
    }
    output += codeSpan(text.slice(after, after + close.index));
    index = after + close.index + run;
  }
  return output;
}
/** Normalize line endings and drop format and control characters. */
function clean(text: string): string {
  return text
    .replace(/\r\n?/gu, '\n')
    .replace(/\p{Cf}/gu, '')
    .replace(/[^\P{Cc}\n\t]/gu, ' ');
}
/**
 * Sanitize single-line agent text such as a finding title. It is rendered
 * inline only, never with fence detection, so a leading fence run cannot
 * open a block that swallows the trusted content after it.
 */
export function sanitizeTitle(text: string): string {
  return sanitizeInline(
    clean(text)
      .replace(/\s*\n\s*/gu, ' ')
      .trim(),
  );
}
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,}).*$/u;

/**
 * Sanitize agent prose for GitHub Markdown. Control and format characters
 * are removed; fenced blocks and code spans are re-emitted with delimiters
 * the content cannot close; everything else is escaped so it cannot form
 * HTML (including comments and markers), mentions, references, links or
 * images.
 */
export function sanitizeProse(text: string, maxLines = 400): string {
  const lines = clean(text).split('\n').slice(0, maxLines);
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = FENCE_OPEN.exec(line);
    // A backtick fence's info string may not contain backticks; such a line
    // is inline text (CommonMark).
    const infoHasBacktick =
      fence !== null &&
      fence[1]!.startsWith('`') &&
      line.trimStart().slice(fence[1]!.length).includes('`');
    if (fence && !infoHasBacktick) {
      const marker = fence[1]!;
      const block: string[] = [];
      index += 1;
      while (index < lines.length) {
        const closing = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(lines[index]!);
        if (
          closing &&
          closing[1]![0] === marker[0] &&
          closing[1]!.length >= marker.length
        )
          break;
        block.push(lines[index]!);
        index += 1;
      }
      index += 1;
      // Agent info strings are dropped: GitHub treats some (`suggestion`)
      // as commands, and only trusted code may emit a suggestion fence.
      output.push(codeFence(block.join('\n')));
      continue;
    }
    output.push(sanitizeInline(line));
    index += 1;
  }
  return output.join('\n');
}

function severityLabel(severity: Severity): string {
  return severity.toUpperCase();
}
function passList(passes: readonly ReviewPass[]): string {
  return passes.map((pass) => PASS_LABELS[pass]).join(', ');
}
function exitText(exitCode: number | null): string {
  return exitCode === null ? 'killed' : `exit ${exitCode}`;
}
function evidenceLine(finding: GatedFinding): string {
  return finding.evidence
    .map((item) =>
      item.kind === 'check'
        ? `check ${codeSpan(item.name)} (${exitText(item.exit_code)}, ${codeSpan(item.evidence_id)})`
        : codeSpan(
            `${item.side === 'LEFT' ? 'base:' : ''}${item.path}:${item.line}${
              item.end_line > item.line ? `-${item.end_line}` : ''
            }`,
          ),
    )
    .join(', ');
}

/** Body of one inline comment, ending with its trusted marker. */
export function renderFindingBody(
  finding: GatedFinding,
  identity: ReviewIdentity,
): string {
  const parts = [
    `**${severityLabel(finding.severity)}** · ${finding.category} · ${sanitizeTitle(finding.title)}`,
    sanitizeProse(finding.body),
  ];
  if (finding.suggestion_status === 'kept' && finding.suggestion !== null)
    parts.push(codeFence(finding.suggestion, 'suggestion'));
  const meta = [`Raised by: ${passList(finding.passes)}`];
  if (finding.evidence.length) meta.push(`Evidence: ${evidenceLine(finding)}`);
  if (finding.rule_id) meta.push(`Rule: ${codeSpan(finding.rule_id)}`);
  parts.push(`<sub>${meta.join(' · ')}</sub>`);
  parts.push(findingMarker(identity, finding));
  return parts.join('\n\n');
}

/** Inline comment payload for one posted finding. */
export function renderInlineComment(
  finding: GatedFinding,
  identity: ReviewIdentity,
): ReviewComment {
  const position = finding.diff_position;
  return {
    path: position.path,
    body: renderFindingBody(finding, identity),
    line: position.line,
    side: position.side,
    ...(position.start_line === null
      ? {}
      : { start_line: position.start_line, start_side: position.side }),
  };
}

/**
 * The single `COMMENT` review for this run, or `null` when nothing new is
 * posted (the summary comment is still updated).
 */
export function renderReview(gated: GatedReview): ReviewPayload | null {
  const posted = gated.findings.filter((f) => f.disposition === 'posted');
  if (posted.length === 0) return null;
  const body = [
    `**agent-ci PR review** posted ${posted.length} new finding${
      posted.length === 1 ? '' : 's'
    } for ${codeSpan(gated.head_sha.slice(0, 12))}. The summary comment lists every finding and the run status.`,
    reviewMarker(gated.identity),
  ].join('\n\n');
  return {
    commit_id: gated.head_sha,
    event: 'COMMENT',
    body,
    comments: posted.map((finding) =>
      renderInlineComment(finding, gated.identity),
    ),
  };
}

function count(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value).toLocaleString('en-US')
    : 'unknown';
}
function cost(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `$${value.toFixed(4)}`
    : 'not reported';
}
function model(value: string | null | undefined): string {
  return typeof value === 'string' && value.trim() !== ''
    ? codeSpan(value.slice(0, 120))
    : 'unknown';
}

/** The single summary comment for this scope, ending with its marker. */
export type SummaryOptions = {
  /**
   * GitHub rejected the inline review, so nothing was posted inline: the
   * findings meant for inline comments are listed in the summary instead,
   * and no count claims an inline comment.
   */
  inlineRejected?: boolean;
};

export function renderSummary(
  gated: GatedReview,
  usage: readonly UsageRow[] = [],
  options: SummaryOptions = {},
): string {
  const lines: string[] = ['## agent-ci PR review', ''];
  // A truncated diff is never presented as a complete review, even when
  // every reviewer pass succeeded.
  const status =
    gated.review_status !== 'complete'
      ? '**incomplete**'
      : gated.diff_truncated
        ? '**partial (diff truncated)**'
        : 'complete';
  lines.push(
    `**Mode:** ${codeSpan(gated.mode)} · **Review:** ${status} · **Head:** ${codeSpan(
      gated.head_sha.slice(0, 12),
    )}`,
    '',
  );
  const failed = gated.passes.filter((p) => p.enabled && p.status === 'failed');
  if (gated.review_status === 'incomplete')
    lines.push(
      `> [!WARNING]\n> Incomplete review: ${
        failed.length
          ? `the ${passList(failed.map((p) => p.pass))} produced no valid output`
          : 'no reviewer pass ran'
      }. Findings below come only from passes that completed, and this run fails after publishing.`,
      '',
    );
  if (gated.diff_truncated)
    lines.push(
      '> [!WARNING]\n> The PR diff was truncated. Changes beyond the truncation point were not reviewed, so this is not a complete review of the PR.',
      '',
    );
  if (gated.adjudication.enabled && gated.adjudication.status === 'failed')
    lines.push(
      '> [!NOTE]\n> The adjudicator did not produce valid output, so no findings were dropped or downgraded. Every reviewer finding below still stands.',
      '',
    );
  if (gated.fail_on_severity_triggered && gated.policy.fail_on_severity)
    lines.push(
      `> [!CAUTION]\n> A finding at or above ${codeSpan(
        gated.policy.fail_on_severity,
      )} was reported, so this workflow run fails after publishing.`,
      '',
    );

  lines.push(
    '### Passes',
    '',
    '| Pass | Status | Model | Input tokens | Output tokens | Cache read tokens | Cache write tokens | Reported cost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  const passStatus = new Map<string, string>(
    gated.passes.map((p) => [
      p.pass,
      p.status === 'valid' ? 'completed' : p.status,
    ]),
  );
  passStatus.set(
    'adjudicator',
    gated.adjudication.status === 'completed'
      ? 'completed'
      : gated.adjudication.status,
  );
  for (const pass of ['primary', 'second', 'adjudicator'] as const) {
    const row = usage.find((u) => u.pass === pass);
    const state = passStatus.get(pass) ?? 'disabled';
    if (state === 'disabled' && !row) {
      lines.push(`| ${PASS_LABELS[pass]} | disabled | - | - | - | - | - | - |`);
      continue;
    }
    lines.push(
      `| ${PASS_LABELS[pass]} | ${state} | ${model(row?.model)} | ${count(
        row?.input_tokens,
      )} | ${count(row?.output_tokens)} | ${count(
        row?.cache_read_tokens,
      )} | ${count(row?.cache_write_tokens)} | ${cost(
        row?.reported_cost_usd,
      )} |`,
    );
  }
  lines.push(
    '',
    'Token counts are what each harness reported for the pass, including a repair turn; unknown means the harness did not report them. Cost is shown only when the harness reported one (a subscription or proxy route may report a list-price figure that is not billed).',
    '',
  );
  if (gated.mode === 'verify-review') {
    lines.push('### Checks', '');
    if (gated.checks === undefined || gated.checks === null) {
      lines.push(
        'No valid check evidence reached the findings gate, so no finding could cite a check.',
        '',
      );
    } else if (gated.checks.status === 'setup-failed') {
      lines.push(
        'The setup command failed, so no check ran and no finding could cite one.',
        '',
      );
    } else {
      lines.push(
        '| Check | Result | Isolation | Evidence |',
        '| --- | --- | --- | --- |',
        ...gated.checks.entries.map(
          (entry) =>
            `| ${codeSpan(entry.name)} | ${entry.timed_out ? 'timed out' : exitText(entry.exit_code)} | ${codeSpan(entry.isolation)} | ${codeSpan(entry.evidence_id)} |`,
        ),
        '',
        'agent-ci ran these configured checks on the PR head in a job without model credentials; their results reflect the PR code itself.',
        '',
      );
    }
  }
  const notes = usage.flatMap((row) =>
    (Array.isArray(row.notes) ? row.notes : [])
      .filter((note): note is string => typeof note === 'string')
      .slice(0, 5)
      .map(
        (note) =>
          `- **${PASS_LABELS[row.pass] ?? 'pass'}:** ${sanitizeTitle(Array.from(note).slice(0, 300).join(''))}`,
      ),
  );
  if (notes.length > 0) lines.push('### Pass notes', '', ...notes, '');

  const findings = gated.findings;
  const by = (disposition: GatedFinding['disposition']) =>
    findings.filter((f) => f.disposition === disposition);
  lines.push(
    '### Findings',
    '',
    '| Severity | Reported this run | New inline | Already posted |',
    '| --- | --- | --- | --- |',
  );
  // Counts follow what was actually published: when GitHub rejected the
  // inline review, nothing new was posted inline.
  const rejected = options.inlineRejected === true ? by('posted') : [];
  const postedInline = rejected.length > 0 ? [] : by('posted');
  for (const severity of SEVERITIES) {
    const ofSeverity = findings.filter((f) => f.severity === severity);
    lines.push(
      `| ${severity} | ${ofSeverity.length} | ${
        postedInline.filter((f) => f.severity === severity).length
      } | ${ofSeverity.filter((f) => f.disposition === 'duplicate').length} |`,
    );
  }
  const open = postedInline.length + by('duplicate').length;
  lines.push(
    '',
    `- **Still open:** ${open} finding${open === 1 ? '' : 's'} reported this run with an inline comment (${postedInline.length} new, ${by('duplicate').length} already posted).`,
  );
  if (rejected.length > 0)
    lines.push(
      `- **Rejected inline by GitHub:** ${rejected.length} new finding${
        rejected.length === 1 ? ' was' : 's were'
      } meant for an inline comment but not posted inline. ${
        rejected.length === 1 ? 'It is' : 'They are'
      } listed below, and a later run can post ${
        rejected.length === 1 ? 'it' : 'them'
      } inline again.`,
    );
  lines.push(
    `- **Not reproduced this run:** ${gated.not_reproduced.length} previously posted finding${
      gated.not_reproduced.length === 1 ? ' was' : 's were'
    } not reported by this run. That does not establish that ${
      gated.not_reproduced.length === 1 ? 'it was' : 'they were'
    } fixed.`,
    `- **Over the comment budget:** ${by('over_budget').length} (limit ${gated.policy.budget} inline comments per run).`,
    `- **Below the ${codeSpan(gated.policy.floor)} floor:** ${by('below_floor').length} (summary only).`,
  );
  const dropped = gated.candidates.filter(
    (c) => c.disposition === 'dropped_by_adjudicator',
  ).length;
  const invalid = gated.candidates.filter((c) =>
    c.disposition.startsWith('invalid:'),
  ).length;
  lines.push(
    `- **Dropped by the adjudicator:** ${dropped}. **Rejected by validation:** ${invalid}.`,
    '',
  );

  // Everything below is variable-length agent-derived text. It is added in
  // order (rejected inline findings first) while it fits the summary
  // budget; the rest is counted in a visible note, never silently cut.
  const chunks: { lines: string[]; heading?: boolean }[] = [];
  const position = (finding: GatedFinding) =>
    codeSpan(
      `${finding.diff_position.side === 'LEFT' ? 'base:' : ''}${finding.diff_position.path}:${finding.diff_position.line}`,
    );
  if (rejected.length > 0) {
    chunks.push({
      lines: [`### ${REJECTED_HEADING}`, ''],
      heading: true,
    });
    let room = REJECTED_DETAIL_BYTES;
    for (const finding of rejected) {
      const item = [
        `- **${severityLabel(finding.severity)}** ${position(finding)} ${listTitle(
          finding.title,
        )} (inline review rejected; raised by ${passList(finding.passes)})`,
      ];
      const detail = sanitizeProse(finding.body, REJECTED_DETAIL_LINES);
      const size = Buffer.byteLength(detail, 'utf8');
      if (detail.trim() !== '' && size <= room) {
        room -= size;
        item.push(
          '',
          '  <details><summary>Explanation</summary>',
          '',
          ...detail.split('\n').map((line) => (line === '' ? '' : `  ${line}`)),
          '',
          '  </details>',
          '',
        );
      }
      chunks.push({ lines: item });
    }
  }

  const summaryOnly = findings.filter(
    (f) => f.disposition === 'below_floor' || f.disposition === 'over_budget',
  );
  if (summaryOnly.length) {
    chunks.push({
      lines: ['', '### Summary-only findings', ''],
      heading: true,
    });
    for (const finding of summaryOnly)
      chunks.push({
        lines: [
          `- **${severityLabel(finding.severity)}** ${position(finding)} ${listTitle(
            finding.title,
          )} (${
            finding.disposition === 'over_budget'
              ? 'over budget'
              : 'below floor'
          }; raised by ${passList(finding.passes)})`,
        ],
      });
  }

  for (const { pass, summary } of gated.summaries)
    if (summary.trim())
      chunks.push({
        lines: [
          '',
          `<details><summary>${PASS_LABELS[pass]} notes</summary>`,
          '',
          sanitizeProse(summary, 80),
          '',
          '</details>',
        ],
      });

  const marker = summaryMarker(gated.identity);
  let room =
    SUMMARY_MAX_CHARS -
    lines.join('\n').length -
    marker.length -
    SUMMARY_NOTE_RESERVE;
  let omitted = 0;
  let heading: string[] | null = null;
  for (const chunk of chunks) {
    if (chunk.heading) {
      heading = chunk.lines;
      continue;
    }
    const text = [...(heading ?? []), ...chunk.lines].join('\n').length + 1;
    if (omitted === 0 && text <= room) {
      if (heading) lines.push(...heading);
      lines.push(...chunk.lines);
      room -= text;
    } else {
      omitted += 1;
    }
    heading = null;
  }
  if (omitted > 0)
    lines.push(
      '',
      `> [!NOTE]\n> This summary was shortened to fit GitHub's comment size limit: ${omitted} more ${
        omitted === 1 ? 'entry is' : 'entries are'
      } in this run's gated review artifact.`,
    );
  lines.push('');
  lines.push(marker);
  return lines.join('\n');
}

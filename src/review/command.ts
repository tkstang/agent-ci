import { ReviewError, type ReviewMode } from '@agent-ci/review/contracts.js';
import {
  MODEL_NAME,
  REQUEST_LIMITS,
  type ResolvedRequestConfig,
  validateRequestConfig,
} from '@agent-ci/review/request.js';

/**
 * PR review comment commands, ported from pntr's `pntr-pr-review/command.ts`
 * (voxmedia/pntr@e438668). Pure and hermetic: the gate passes the comment
 * body (read from the event payload, never from shell source) and the
 * workflow's trusted defaults.
 *
 *   /agent-ci-review [key=value ...] [--] [request instruction ...]
 *   <request instruction continues on following lines>
 *
 * Options come only from the first line, as leading `key=value` tokens split
 * at the first `=`. `--` ends the options; otherwise the first token that is
 * not an option starts the request instruction, and later `key=value` text
 * is instruction. Following lines are always instruction. There is no
 * quoting or escaping. Labels carry no options.
 */

/** Comment commands; `/agent-ci-verify-review` arrives with p04. */
export const REVIEW_COMMANDS: Readonly<Record<string, ReviewMode>> =
  Object.freeze({
    '/agent-ci-review': 'review',
  });
/** Trigger labels; `agent-ci:verify-review` arrives with p04. */
export const REVIEW_LABELS: Readonly<Record<string, ReviewMode>> =
  Object.freeze({
    'agent-ci:review': 'review',
  });

export const OPTION_KEYS = Object.freeze([
  'reviewer_model',
  'second_reviewer',
  'second_reviewer_model',
  'adjudicator',
  'adjudicator_model',
] as const);
export type OptionKey = (typeof OPTION_KEYS)[number];
const BOOLEAN_KEYS = new Set<OptionKey>(['second_reviewer', 'adjudicator']);

export type CommandOptions = {
  reviewer_model?: string;
  second_reviewer?: boolean;
  second_reviewer_model?: string;
  adjudicator?: boolean;
  adjudicator_model?: string;
};

export type ParsedCommand = {
  command: string;
  mode: ReviewMode;
  options: CommandOptions;
  /** Request instruction; `''` when none. Unicode and formatting kept. */
  instruction: string;
};

/** Text that is not a review command at all; the gate ignores it. */
export type NotACommand = { kind: 'not-command' };
export type CommandParse = ({ kind: 'command' } & ParsedCommand) | NotACommand;

/**
 * A commenter's mistake. `message` is safe Markdown: every commenter token
 * in it is rendered through {@link inlineCode}.
 */
export type CommandError = ReviewError & { command: string };

/** Booleans accepted by `second_reviewer=` and `adjudicator=`. */
const TRUE_VALUES = new Set(['true', '1', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'off']);

/**
 * Characters never allowed in command syntax: controls (other than the tab
 * separator), format characters such as zero-width spaces and bidi
 * overrides, and every separator other than the ASCII space.
 */
const INVISIBLE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{a0}\u{1680}\u{2000}-\u{200a}\u{202f}\u{205f}\u{3000}\u{feff}]/u;
const SEPARATOR = /[ \t]+/u;

const PREVIEW_CODE_POINTS = 80;

/**
 * Render untrusted text as one inline code span that cannot break out:
 * invisible and control characters become visible `\u{..}` escapes, the
 * text is shortened, and the fence is longer than any backtick run inside.
 * GitHub does not resolve mentions or references inside code spans.
 */
export function inlineCode(text: string): string {
  const points = [...text];
  const visible = points
    .slice(0, PREVIEW_CODE_POINTS)
    .map((ch) =>
      INVISIBLE.test(ch) || ch === '\t'
        ? `\\u{${ch.codePointAt(0)!.toString(16)}}`
        : ch,
    )
    .join('');
  const shown = points.length > PREVIEW_CODE_POINTS ? `${visible}…` : visible;
  const longest = Math.max(
    0,
    ...[...shown.matchAll(/`+/gu)].map((match) => match[0].length),
  );
  const fence = '`'.repeat(longest + 1);
  const pad = shown.startsWith('`') || shown.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${shown}${pad}${fence}`;
}

function commandError(command: string, message: string): CommandError {
  return Object.assign(new ReviewError('E_REVIEW_REQUEST', message), {
    command,
  });
}

/** True for a commenter's command mistake (answered with one reply). */
export function isCommandError(error: unknown): error is CommandError {
  return (
    error instanceof ReviewError &&
    typeof (error as { command?: unknown }).command === 'string'
  );
}

/** Lines in LF form; a CR on its own also ends a line. */
function normalizeLines(text: string): string {
  return text.replace(/\r\n?/gu, '\n');
}

/**
 * Parse a PR comment body. Returns `not-command` for text that does not
 * start with a review command (ignored without a reply), and throws a
 * {@link CommandError} for a malformed review command.
 */
export function parseReviewCommand(body: unknown): CommandParse {
  if (typeof body !== 'string') return { kind: 'not-command' };
  const text = normalizeLines(body);
  const newline = text.indexOf('\n');
  const first = newline === -1 ? text : text.slice(0, newline);
  const rest = newline === -1 ? '' : text.slice(newline + 1);
  const commandMatch = /^[^ \t]*/u.exec(first)![0];
  const mode = Object.hasOwn(REVIEW_COMMANDS, commandMatch)
    ? REVIEW_COMMANDS[commandMatch]
    : undefined;
  if (mode === undefined) {
    // A command fused to an invisible or control character (for example a
    // no-break space) is a malformed command, answered rather than ignored.
    const fused = Object.keys(REVIEW_COMMANDS).find((name) => {
      const next = Array.from(commandMatch.slice(name.length))[0];
      return (
        commandMatch.startsWith(name) &&
        next !== undefined &&
        INVISIBLE.test(next)
      );
    });
    if (fused !== undefined)
      throw commandError(
        fused,
        `\`${fused}\` is followed by an invisible or control character (${inlineCode(Array.from(commandMatch.slice(fused.length)).slice(0, 2).join(''))}). Separate the command from its options with a plain space.`,
      );
    return { kind: 'not-command' };
  }
  const command = commandMatch;

  // Limits apply only once the text is a review command, so an unrelated
  // long comment is ignored rather than answered.
  if (Buffer.byteLength(body, 'utf8') > REQUEST_LIMITS.commentBytes)
    throw commandError(
      command,
      `the comment is longer than ${REQUEST_LIMITS.commentBytes} bytes. Shorten the request instruction.`,
    );

  const options: CommandOptions = {};
  const seen = new Set<string>();
  let cursor = command.length;
  let instructionStart: number | null = null;
  while (cursor < first.length) {
    const gap = SEPARATOR.exec(first.slice(cursor));
    if (gap === null || gap.index !== 0) break;
    cursor += gap[0].length;
    if (cursor >= first.length) break;
    const token = /^[^ \t]+/u.exec(first.slice(cursor))![0];
    if (token === '--') {
      cursor += token.length;
      instructionStart = cursor;
      break;
    }
    const equals = token.indexOf('=');
    if (equals === -1) {
      instructionStart = cursor;
      break;
    }
    if (INVISIBLE.test(token))
      throw commandError(
        command,
        `${inlineCode(token)} contains an invisible or control character. Retype the option.`,
      );
    const key = token.slice(0, equals);
    const value = token.slice(equals + 1);
    if (key === '')
      throw commandError(
        command,
        `${inlineCode(token)} has no option name before \`=\`.`,
      );
    if (!(OPTION_KEYS as readonly string[]).includes(key))
      throw commandError(
        command,
        `${inlineCode(key)} is not an option. Options: ${OPTION_KEYS.map((k) => `\`${k}\``).join(', ')}. Put \`--\` before an instruction that starts with \`name=value\` text.`,
      );
    if (seen.has(key))
      throw commandError(
        command,
        `${inlineCode(key)} is given more than once.`,
      );
    seen.add(key);
    if (value === '')
      throw commandError(command, `${inlineCode(key)} has an empty value.`);
    const optionKey = key as OptionKey;
    if (BOOLEAN_KEYS.has(optionKey)) {
      if (!TRUE_VALUES.has(value) && !FALSE_VALUES.has(value))
        throw commandError(
          command,
          `${inlineCode(token)} is not a valid switch. Use \`${key}=true\`, \`on\` or \`1\` to turn it on, or \`false\`, \`off\` or \`0\` to turn it off.`,
        );
      (options as Record<string, boolean>)[optionKey] = TRUE_VALUES.has(value);
    } else {
      // Model names are checked here, so a malformed one is answered as the
      // commenter's mistake, not a workflow misconfiguration.
      if (!MODEL_NAME.test(value))
        throw commandError(
          command,
          `${inlineCode(value)} is not a model name for \`${key}\`. Use a model from allowed_models, for example \`${key}=claude-haiku-4-5\`.`,
        );
      (options as Record<string, string>)[optionKey] = value;
    }
    cursor += token.length;
  }

  for (const pass of ['second_reviewer', 'adjudicator'] as const)
    if (options[pass] === false && options[`${pass}_model`] !== undefined)
      throw commandError(
        command,
        `\`${pass}=false\` turns the pass off, so \`${pass}_model\` cannot be set with it.`,
      );

  // Keep the instruction's formatting: drop only the command-line delimiter,
  // blank leading and trailing lines, and trailing whitespace at the end;
  // every line keeps its own indentation.
  const head =
    instructionStart === null
      ? ''
      : first.slice(instructionStart).replace(/^[ \t]+/u, '');
  const lines = rest === '' ? [head] : [head, ...rest.split('\n')];
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();
  const instruction = lines.join('\n').trimEnd();
  if (
    [...instruction].length > REQUEST_LIMITS.instructionCodePoints ||
    Buffer.byteLength(instruction, 'utf8') > REQUEST_LIMITS.instructionBytes
  )
    throw commandError(
      command,
      `the request instruction is longer than ${REQUEST_LIMITS.instructionCodePoints} characters or ${REQUEST_LIMITS.instructionBytes} bytes. Shorten it.`,
    );
  return { kind: 'command', command, mode, options, instruction };
}

/** The workflow file's trusted pass settings. */
export type WorkflowPassDefaults = {
  reviewer_model: string;
  second_reviewer: boolean;
  second_reviewer_model: string;
  adjudicator: boolean;
  adjudicator_model: string;
};

/**
 * Resolve each pass's on/off state and model. A command model turns its
 * pass on; a command switch overrides the workflow's switch; otherwise the
 * workflow's switch and default model apply. A workflow default model never
 * turns a pass on by itself.
 */
export function resolveRequestConfig(input: {
  mode: ReviewMode;
  options?: CommandOptions;
  defaults: WorkflowPassDefaults;
  instruction?: string;
}): ResolvedRequestConfig {
  const options = input.options ?? {};
  const { defaults } = input;
  const optional = (
    pass: 'second_reviewer' | 'adjudicator',
  ): { enabled: boolean; model: string } => {
    const model = options[`${pass}_model`];
    const toggle = options[pass];
    if (toggle === false && model !== undefined)
      throw commandError(
        '',
        `\`${pass}=false\` turns the pass off, so \`${pass}_model\` cannot be set with it.`,
      );
    if (model !== undefined) return { enabled: true, model };
    return {
      enabled: toggle ?? defaults[pass],
      model: defaults[`${pass}_model`],
    };
  };
  return validateRequestConfig({
    version: 1,
    mode: input.mode,
    primary: { model: options.reviewer_model ?? defaults.reviewer_model },
    second: optional('second_reviewer'),
    adjudicator: optional('adjudicator'),
    instruction: input.instruction ?? '',
  });
}

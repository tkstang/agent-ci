import { adapterFor } from '@agent-ci/harness/adapters/registry.js';
import {
  type CommandOptions,
  inlineCode,
  isCommandError,
  parseReviewCommand,
  resolveRequestConfig,
  REVIEW_COMMANDS,
  REVIEW_LABELS,
  type WorkflowPassDefaults,
} from '@agent-ci/review/command.js';
import {
  contractError,
  isReviewError,
  type ReviewMode,
  SEVERITIES,
  type Severity,
  sha256,
} from '@agent-ci/review/contracts.js';
import { type GithubClient, repositoryPath } from '@agent-ci/review/github.js';
import {
  MODEL_NAME,
  type ResolvedRequestConfig,
} from '@agent-ci/review/request.js';
import { resolveRoute } from '@agent-ci/routing/resolve.js';
import type { ModelsFile } from '@agent-ci/routing/schema.js';

/**
 * The PR review permission gate, ported from pntr's
 * `pntr-ci/resolve-trigger.ts` (PR review part) and
 * `pntr-pr-review/trigger.ts` (voxmedia/pntr@e438668). It runs in a job
 * that holds only a GitHub token: no model credential, no PR checkout.
 *
 * 1. `authorizeRequest`: resolve the event, look up only the facts the
 *    decision needs (sender permission, the PR, the PR author's permission)
 *    and capture the PR snapshot. Unauthorized requests are skipped with a
 *    notice; lookup failures fail closed.
 * 2. `configureRequest`: parse the command, resolve each pass's model, and
 *    check every selected model against `allowed_models` and the routing
 *    table under this environment's policy (the adjudicator only on a
 *    harness with a verified tool-free posture).
 * 3. `acknowledgeRequest`: consume the trigger label, then either reply once
 *    and stop, or add `eyes` and bind the request.
 *
 * Commenter text (the command and instruction) lives only in the request
 * record; no step output carries it.
 *
 * Events: `pull_request_target` and `pull_request` (`labeled`),
 * `issue_comment` (`created`) and `workflow_dispatch`. Consumers trigger on
 * `pull_request_target` (the workflow and its pins come from the default
 * branch); `pull_request` serves pre-merge tests from a branch.
 */

export const PR_REVIEW_EVENTS = Object.freeze([
  'pull_request_target',
  'pull_request',
  'issue_comment',
  'workflow_dispatch',
] as const);
export type PrReviewEvent = (typeof PR_REVIEW_EVENTS)[number];
export type PrReviewTrigger = 'label' | 'comment' | 'dispatch';

const AUTHORIZED_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
export function isAuthorizedPermission(level: unknown): boolean {
  return AUTHORIZED_PERMISSIONS.has(
    String(level ?? '')
      .trim()
      .toLowerCase(),
  );
}

export type PrReviewFacts = {
  /** Collaborator permission of the event sender. */
  actorPermission?: string;
  /** `GET /repos/{repo}/pulls/{n}` (untrusted). */
  pullRequest?: unknown;
  /** Collaborator permission of the PR author. */
  authorPermission?: string;
};
export type PrReviewFact = keyof PrReviewFacts;

export type PrReviewGateOptions = {
  /** Trusted `owner/name` of the repository running the workflow. */
  repository: string;
  /** PR-scoped dispatch: the `pr_number` and `command` workflow inputs. */
  dispatchPrNumber?: unknown;
  dispatchCommand?: unknown;
  /** Explicit trust grant for bot PR authors (exact logins). */
  allowedPrAuthors?: readonly string[];
  /** Facts looked up so far; the decision asks for the next one it needs. */
  facts?: PrReviewFacts;
};

/** Silent: not a review request at all. */
export type PrReviewIgnoreReason =
  | 'unrelated-event'
  | 'unrelated-label'
  | 'edited-comment'
  | 'not-a-command'
  | 'not-a-pull-request'
  | 'bot-command';
/** Visible (`::notice` and job summary): a request that is not authorized. */
export type PrReviewSkipReason =
  | 'invalid-dispatch'
  | 'unauthorized-actor'
  | 'fork'
  | 'closed'
  | 'draft'
  | 'bot-author'
  | 'unauthorized-author';

export type PrReviewRequest = {
  trigger: PrReviewTrigger;
  prNumber: number;
  /** Mode from the label; `null` for commands (parsed after authorization). */
  labelMode: ReviewMode | null;
  label: string | null;
  /** Comment or dispatch command text (untrusted; never an output). */
  commandText: string | null;
  commentId: number | null;
  sender: string;
};
export type PrReviewPullRequest = {
  number: number;
  headSha: string;
  baseSha: string;
  baseRef: string;
  author: string;
  authorType: 'User' | 'Bot';
  title: string;
  body: string;
};
export type PrReviewDecision =
  | { status: 'ignore'; reason: PrReviewIgnoreReason }
  | {
      status: 'skip';
      reason: PrReviewSkipReason;
      request: PrReviewRequest | null;
      notice: string;
    }
  | {
      status: 'need';
      fact: PrReviewFact;
      /** Login for a permission lookup. */
      login: string | null;
      request: PrReviewRequest;
    }
  | {
      status: 'authorized';
      request: PrReviewRequest;
      pullRequest: PrReviewPullRequest;
    };

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/u;
const SHA = /^[0-9a-f]{40}$/u;

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
function isBot(user: unknown): boolean {
  const name = field(user, 'login');
  return (
    field(user, 'type') === 'Bot' ||
    (typeof name === 'string' && name.endsWith('[bot]'))
  );
}
function login(user: unknown): string | null {
  const value = field(user, 'login');
  return typeof value === 'string' && LOGIN.test(value) ? value : null;
}
function positiveInteger(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!/^[1-9][0-9]{0,9}$/u.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}
/** First whitespace-delimited token of the first line, exactly. */
function commandToken(text: string): string {
  return /^[^ \t\r\n]*/u.exec(text)?.[0] ?? '';
}
/** Invisible, control and non-ASCII space characters. */
const FUSED =
  /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{a0}\u{1680}\u{2000}-\u{200a}\u{202f}\u{205f}\u{3000}\u{feff}]/u;
/**
 * True when `text` starts with a known command: exactly, or fused to an
 * invisible or control character, which the parser then rejects with a
 * reply instead of the request being silently ignored.
 */
function isCommand(text: string): boolean {
  const token = commandToken(text);
  if (Object.hasOwn(REVIEW_COMMANDS, token)) return true;
  return Object.keys(REVIEW_COMMANDS).some(
    (name) => token.startsWith(name) && FUSED.test(token.slice(name.length)),
  );
}

/** Validate the fields of a fetched PR the gate relies on; `null` if malformed. */
export function readPullRequest(
  value: unknown,
  prNumber: number,
):
  | (PrReviewPullRequest & {
      state: unknown;
      draft: boolean;
      headRepo: string | null;
      baseRepo: string | null;
    })
  | null {
  const head = field(value, 'head');
  const base = field(value, 'base');
  const user = field(value, 'user');
  const author = login(user);
  const headSha = field(head, 'sha');
  const baseSha = field(base, 'sha');
  const baseRef = field(base, 'ref');
  const headRepo = field(field(head, 'repo'), 'full_name');
  const baseRepo = field(field(base, 'repo'), 'full_name');
  if (
    field(value, 'number') !== prNumber ||
    author === null ||
    typeof headSha !== 'string' ||
    !SHA.test(headSha) ||
    typeof baseSha !== 'string' ||
    !SHA.test(baseSha) ||
    typeof baseRef !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u.test(baseRef) ||
    baseRef.includes('..') ||
    typeof field(value, 'state') !== 'string'
  )
    return null;
  const title = field(value, 'title');
  const body = field(value, 'body');
  return {
    number: prNumber,
    headSha,
    baseSha,
    baseRef,
    author,
    authorType: isBot(user) ? 'Bot' : 'User',
    title: typeof title === 'string' ? title : '',
    body: typeof body === 'string' ? body : '',
    state: field(value, 'state'),
    draft: field(value, 'draft') === true,
    headRepo: typeof headRepo === 'string' ? headRepo : null,
    baseRepo: typeof baseRepo === 'string' ? baseRepo : null,
  };
}

function classify(
  eventName: PrReviewEvent,
  event: unknown,
  options: PrReviewGateOptions,
):
  | { status: 'ignore'; reason: PrReviewIgnoreReason }
  | { status: 'skip'; reason: PrReviewSkipReason; notice: string }
  | { status: 'request'; request: PrReviewRequest } {
  const sender = field(event, 'sender');
  if (eventName === 'pull_request_target' || eventName === 'pull_request') {
    if (field(event, 'action') !== 'labeled')
      return { status: 'ignore', reason: 'unrelated-event' };
    const label = field(field(event, 'label'), 'name');
    if (typeof label !== 'string' || !Object.hasOwn(REVIEW_LABELS, label))
      return { status: 'ignore', reason: 'unrelated-label' };
    if (isBot(sender)) return { status: 'ignore', reason: 'bot-command' };
    const prNumber = positiveInteger(
      field(field(event, 'pull_request'), 'number'),
    );
    const actor = login(sender);
    if (prNumber === null || actor === null)
      return { status: 'ignore', reason: 'unrelated-event' };
    return {
      status: 'request',
      request: {
        trigger: 'label',
        prNumber,
        labelMode: REVIEW_LABELS[label] ?? null,
        label,
        commandText: null,
        commentId: null,
        sender: actor,
      },
    };
  }
  if (eventName === 'issue_comment') {
    if (field(event, 'action') !== 'created')
      return { status: 'ignore', reason: 'edited-comment' };
    const comment = field(event, 'comment');
    const body = field(comment, 'body');
    if (typeof body !== 'string' || !isCommand(body))
      return { status: 'ignore', reason: 'not-a-command' };
    // Bot-authored commands are ignored before anything else is checked.
    if (isBot(field(comment, 'user')) || isBot(sender))
      return { status: 'ignore', reason: 'bot-command' };
    const issue = field(event, 'issue');
    if (
      field(issue, 'pull_request') === undefined ||
      field(issue, 'pull_request') === null
    )
      return { status: 'ignore', reason: 'not-a-pull-request' };
    const prNumber = positiveInteger(field(issue, 'number'));
    const commentId = positiveInteger(field(comment, 'id'));
    const actor = login(sender);
    if (
      prNumber === null ||
      commentId === null ||
      actor === null ||
      login(field(comment, 'user')) !== actor
    )
      return { status: 'ignore', reason: 'unrelated-event' };
    return {
      status: 'request',
      request: {
        trigger: 'comment',
        prNumber,
        labelMode: null,
        label: null,
        commandText: body,
        commentId,
        sender: actor,
      },
    };
  }
  // PR-scoped workflow_dispatch.
  if (isBot(sender)) return { status: 'ignore', reason: 'bot-command' };
  const prNumber = positiveInteger(options.dispatchPrNumber);
  const rawCommand =
    typeof options.dispatchCommand === 'string' ? options.dispatchCommand : '';
  const commandText =
    rawCommand.trim() === '' ? Object.keys(REVIEW_COMMANDS)[0]! : rawCommand;
  const actor = login(sender);
  if (prNumber === null || actor === null)
    return {
      status: 'skip',
      reason: 'invalid-dispatch',
      notice: 'A PR review dispatch needs a positive pr_number.',
    };
  if (!isCommand(commandText))
    return {
      status: 'skip',
      reason: 'invalid-dispatch',
      notice: `The dispatch command must start with ${Object.keys(REVIEW_COMMANDS).join(' or ')}.`,
    };
  return {
    status: 'request',
    request: {
      trigger: 'dispatch',
      prNumber,
      labelMode: null,
      label: null,
      commandText,
      commentId: null,
      sender: actor,
    },
  };
}

function skip(
  reason: PrReviewSkipReason,
  request: PrReviewRequest,
  notice: string,
): PrReviewDecision {
  return { status: 'skip', reason, request, notice };
}

/**
 * Decide a PR review request. The checks run in a fixed order: bot-authored
 * commands are ignored, then plain issues, then the sender's permission,
 * then the PR (same repository, open, not a draft), then its author (a bot
 * only when listed in `allowedPrAuthors`; a human with write permission).
 * Each fact is requested only when the decision needs it, so nothing is
 * looked up, replied to or reacted to before authorization.
 */
export function resolvePrReviewTrigger(
  input: PrReviewGateOptions & { eventName: string; event: unknown },
): PrReviewDecision {
  const eventName = String(input.eventName ?? '').trim();
  if (!(PR_REVIEW_EVENTS as readonly string[]).includes(eventName))
    return { status: 'ignore', reason: 'unrelated-event' };
  const classified = classify(eventName as PrReviewEvent, input.event, input);
  if (classified.status === 'ignore') return classified;
  if (classified.status === 'skip') return { ...classified, request: null };
  const { request } = classified;
  const facts = input.facts ?? {};

  if (facts.actorPermission === undefined)
    return {
      status: 'need',
      fact: 'actorPermission',
      login: request.sender,
      request,
    };
  if (!isAuthorizedPermission(facts.actorPermission))
    return skip(
      'unauthorized-actor',
      request,
      `${request.sender} does not have write access, so the review request was not run.`,
    );

  if (facts.pullRequest === undefined)
    return { status: 'need', fact: 'pullRequest', login: null, request };
  const pr = readPullRequest(facts.pullRequest, request.prNumber);
  if (pr === null)
    contractError(
      'E_GITHUB_API',
      'the pull request lookup returned an unusable response',
    );
  if (pr.headRepo !== input.repository || pr.baseRepo !== input.repository)
    return skip(
      'fork',
      request,
      `PR #${pr.number} comes from another repository; only same-repository pull requests are reviewed.`,
    );
  if (pr.state !== 'open')
    return skip('closed', request, `PR #${pr.number} is not open.`);
  if (pr.draft)
    return skip(
      'draft',
      request,
      `PR #${pr.number} is a draft; mark it ready for review first.`,
    );
  const {
    state: _state,
    draft: _draft,
    headRepo: _h,
    baseRepo: _b,
    ...pullRequest
  } = pr;
  if (pr.authorType === 'Bot') {
    const listed = (input.allowedPrAuthors ?? []).some(
      (allowed) => allowed.toLowerCase() === pr.author.toLowerCase(),
    );
    return listed
      ? { status: 'authorized', request, pullRequest }
      : skip(
          'bot-author',
          request,
          `PR #${pr.number} was opened by ${pr.author}, which is not listed in allowed_pr_authors.`,
        );
  }
  if (facts.authorPermission === undefined)
    return {
      status: 'need',
      fact: 'authorPermission',
      login: pr.author,
      request,
    };
  if (!isAuthorizedPermission(facts.authorPermission))
    return skip(
      'unauthorized-author',
      request,
      `PR #${pr.number} was opened by ${pr.author}, who does not have write access.`,
    );
  return { status: 'authorized', request, pullRequest };
}

/** Parse `allowed_pr_authors`: newline- or comma-separated exact logins. */
export function parseAllowedPrAuthors(value: unknown): string[] {
  return String(value ?? '')
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && LOGIN.test(entry));
}

/** Parse `allowed_models`: newline- or comma-separated model names. */
export function parseAllowedModels(value: unknown): string[] {
  const entries = String(value ?? '')
    .split(/[\n,]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  for (const entry of entries)
    if (!MODEL_NAME.test(entry))
      contractError(
        'E_REVIEW_REQUEST',
        `allowed_models entry ${JSON.stringify(entry.slice(0, 80))} is not a model name`,
      );
  return [...new Set(entries)];
}

// ---------------------------------------------------------------------------
// Gate steps
// ---------------------------------------------------------------------------

export type Authorized = {
  request: PrReviewRequest;
  pullRequest: PrReviewPullRequest;
  mergeBaseSha: string;
};

export type AuthorizeOutcome =
  | { status: 'ignore'; reason: string }
  | { status: 'skip'; reason: string; notice: string }
  | { status: 'authorized'; authorized: Authorized };

/** Collaborator permission; a non-collaborator (404) has `none`. */
async function permission(
  github: GithubClient,
  repository: string,
  user: string,
): Promise<string> {
  const body = await github.json(
    {
      method: 'GET',
      path: `${repositoryPath(repository)}/collaborators/${encodeURIComponent(user)}/permission`,
    },
    [200, 404],
  );
  const value = field(body, 'permission');
  return typeof value === 'string' ? value : 'none';
}

/** Merge base of the captured base and head (GitHub's three-dot diff). */
async function mergeBase(
  github: GithubClient,
  repository: string,
  baseSha: string,
  headSha: string,
): Promise<string> {
  const body = await github.json({
    method: 'GET',
    path: `${repositoryPath(repository)}/compare/${baseSha}...${headSha}?per_page=1`,
  });
  const sha = field(field(body, 'merge_base_commit'), 'sha');
  if (typeof sha !== 'string' || !SHA.test(sha))
    contractError('E_GITHUB_API', 'the compare lookup returned no merge base');
  return sha;
}

/** Step 1: authorize the request and capture the PR snapshot. */
export async function authorizeRequest(input: {
  github: GithubClient;
  repository: string;
  eventName: string;
  event: unknown;
  dispatchPrNumber?: string;
  dispatchCommand?: string;
  allowedPrAuthors?: readonly string[];
}): Promise<AuthorizeOutcome> {
  const facts: PrReviewFacts = {};
  let decision: PrReviewDecision;
  for (;;) {
    decision = resolvePrReviewTrigger({
      eventName: input.eventName,
      event: input.event,
      repository: input.repository,
      dispatchPrNumber: input.dispatchPrNumber,
      dispatchCommand: input.dispatchCommand,
      allowedPrAuthors: input.allowedPrAuthors ?? [],
      facts,
    });
    if (decision.status !== 'need') break;
    if (decision.fact === 'pullRequest')
      facts.pullRequest = await input.github.json({
        method: 'GET',
        path: `${repositoryPath(input.repository)}/pulls/${decision.request.prNumber}`,
      });
    else
      facts[decision.fact] = await permission(
        input.github,
        input.repository,
        decision.login ?? '',
      );
  }
  if (decision.status === 'ignore')
    return { status: 'ignore', reason: decision.reason };
  if (decision.status === 'skip')
    return {
      status: 'skip',
      reason: decision.reason,
      notice: decision.notice,
    };
  return {
    status: 'authorized',
    authorized: {
      request: decision.request,
      pullRequest: decision.pullRequest,
      mergeBaseSha: await mergeBase(
        input.github,
        input.repository,
        decision.pullRequest.baseSha,
        decision.pullRequest.headSha,
      ),
    },
  };
}

/** Why a request did not start, and who can fix it. */
export type GateFailure = {
  /** `command`: the requester's mistake; `configuration`: the workflow's. */
  route: 'command' | 'configuration';
  detail: string;
};

/** The workflow's trusted publication policy inputs. */
export type ReviewPolicyInputs = {
  failOnSeverity?: string;
  minInlineSeverity?: string;
  maxInlineComments?: string;
};
export type ReviewPolicy = {
  fail_on_severity: Severity | null;
  floor: Severity;
  budget: number;
};
export const DEFAULT_POLICY: ReviewPolicy = Object.freeze({
  fail_on_severity: null,
  floor: 'medium',
  budget: 10,
});

function severityInput(
  value: string | undefined,
  name: string,
): Severity | null {
  const text = (value ?? '').trim().toLowerCase();
  if (text === '' || text === 'none') return null;
  if (!(SEVERITIES as readonly string[]).includes(text))
    contractError(
      'E_REVIEW_REQUEST',
      `${name} must be blank, critical, high, medium or low`,
    );
  return text as Severity;
}

/** Parse the publication policy; a bad value is a configuration error. */
export function parsePolicy(inputs: ReviewPolicyInputs): ReviewPolicy {
  const failOn = severityInput(inputs.failOnSeverity, 'fail_on_severity');
  const floor =
    severityInput(inputs.minInlineSeverity, 'min_inline_severity') ??
    DEFAULT_POLICY.floor;
  const budgetText = (inputs.maxInlineComments ?? '').trim();
  let budget = DEFAULT_POLICY.budget;
  if (budgetText !== '') {
    if (
      !/^(?:0|[1-9][0-9]{0,2})$/u.test(budgetText) ||
      Number(budgetText) > 100
    )
      contractError(
        'E_REVIEW_REQUEST',
        'max_inline_comments must be an integer from 0 through 100',
      );
    budget = Number(budgetText);
  }
  return { fail_on_severity: failOn, floor, budget };
}

export type ConfigureOutcome =
  | { status: 'planned'; config: ResolvedRequestConfig }
  | { status: 'failed'; failure: GateFailure };

function fail(route: GateFailure['route'], detail: string): ConfigureOutcome {
  return { status: 'failed', failure: { route, detail } };
}

/**
 * Step 2: parse the command and check every selected model. A selection
 * from the command that is not allowed or not routable is the requester's
 * mistake; a default that is not is the workflow's.
 */
export function configureRequest(input: {
  authorized: Authorized;
  defaults: WorkflowPassDefaults;
  allowedModels: readonly string[];
  models: ModelsFile;
  env: Readonly<Record<string, string | undefined>>;
}): ConfigureOutcome {
  const { request } = input.authorized;
  let mode: ReviewMode;
  let options: CommandOptions = {};
  let instruction = '';
  if (request.trigger === 'label') {
    if (request.labelMode === null)
      return fail('command', 'the label does not name a review mode.');
    mode = request.labelMode;
  } else {
    try {
      const parsed = parseReviewCommand(request.commandText);
      if (parsed.kind !== 'command')
        return fail(
          'command',
          'the text does not start with a review command.',
        );
      mode = parsed.mode;
      options = parsed.options;
      instruction = parsed.instruction;
    } catch (error) {
      if (!isCommandError(error)) throw error;
      return fail('command', error.message);
    }
  }
  let config: ResolvedRequestConfig;
  try {
    config = resolveRequestConfig({
      mode,
      options,
      defaults: input.defaults,
      instruction,
    });
  } catch (error) {
    if (isCommandError(error)) return fail('command', error.message);
    if (isReviewError(error)) return fail('configuration', error.message);
    throw error;
  }
  const passes: {
    name: string;
    model: string;
    fromCommand: boolean;
    adjudicator: boolean;
  }[] = [
    {
      name: 'reviewer',
      model: config.primary.model,
      fromCommand: options.reviewer_model !== undefined,
      adjudicator: false,
    },
  ];
  if (config.second.enabled)
    passes.push({
      name: 'second reviewer',
      model: config.second.model,
      fromCommand: options.second_reviewer_model !== undefined,
      adjudicator: false,
    });
  if (config.adjudicator.enabled)
    passes.push({
      name: 'adjudicator',
      model: config.adjudicator.model,
      fromCommand: options.adjudicator_model !== undefined,
      adjudicator: true,
    });
  for (const pass of passes) {
    const route = pass.fromCommand ? 'command' : 'configuration';
    const shown = inlineCode(pass.model);
    if (!input.allowedModels.includes(pass.model))
      return fail(
        route,
        `the ${pass.name} model ${shown} is not in allowed_models (${input.allowedModels.map((m) => inlineCode(m)).join(', ') || 'empty'}).`,
      );
    const resolved = resolveRoute(input.models, {
      model: pass.model,
      allowPool: false,
      seedLogin: false,
      requireCredentials: false,
      env: input.env,
    });
    if (!resolved.ok)
      return fail(
        route,
        `the ${pass.name} model ${shown} has no usable route here (${resolved.code}).`,
      );
    if (
      pass.adjudicator &&
      !adapterFor(resolved.value.route.harness).supportsNoTools
    )
      return fail(
        route,
        `the adjudicator model ${shown} runs on ${resolved.value.route.harness}; the adjudicator runs only on a harness with a verified tool-free posture (Claude).`,
      );
  }
  return { status: 'planned', config };
}

export type RequestRecord = {
  version: 1;
  request_id: string;
  repository: string;
  pr_number: number;
  trigger: PrReviewTrigger;
  base_ref: string;
  base_sha: string;
  merge_base_sha: string;
  head_sha: string;
  config: ResolvedRequestConfig;
  /** Untrusted PR metadata, passed on as prompt data only. */
  pr: { title: string; body: string };
};

function sourceOf(request: PrReviewRequest, runId: string): string {
  return request.trigger === 'comment'
    ? `comment:${request.commentId}`
    : `run:${runId}`;
}

/** Stable key of one request source, for the once-only reply. */
export function replyKey(
  repository: string,
  request: PrReviewRequest,
  runId: string,
): string {
  return sha256(
    JSON.stringify([
      repository,
      request.prNumber,
      request.trigger,
      sourceOf(request, runId),
      sha256(request.commandText ?? request.label ?? ''),
    ]),
  );
}

/**
 * The bound request identity: the source (comment id or dispatch/label
 * run), the body digest, the captured head and the normalized
 * configuration. A retry of the same run reproduces it exactly.
 */
export function requestId(input: {
  repository: string;
  request: PrReviewRequest;
  runId: string;
  headSha: string;
  config: ResolvedRequestConfig;
}): string {
  const { request } = input;
  return sha256(
    JSON.stringify([
      input.repository,
      request.prNumber,
      request.trigger,
      sourceOf(request, input.runId),
      sha256(request.commandText ?? request.label ?? ''),
      input.headSha,
      input.config,
    ]),
  );
}

/** The login whose comments carry gate replies (the publishing token's). */
export const REPLY_MARKER = 'agent-ci-pr-review gate-reply';

async function replyOnce(input: {
  github: GithubClient;
  repository: string;
  prNumber: number;
  key: string;
  body: string;
  publisherLogin: string;
}): Promise<'posted' | 'already-posted'> {
  const marker = `<!-- ${REPLY_MARKER} ${input.key} -->`;
  const { items } = await input.github.paginate(
    `${repositoryPath(input.repository)}/issues/${input.prNumber}/comments`,
    10,
  );
  const posted = items.some((item) => {
    const user = field(item, 'user');
    const body = field(item, 'body');
    return (
      field(user, 'login') === input.publisherLogin &&
      typeof body === 'string' &&
      body.trimEnd().split('\n').at(-1) === marker
    );
  });
  if (posted) return 'already-posted';
  await input.github.send({
    method: 'POST',
    path: `${repositoryPath(input.repository)}/issues/${input.prNumber}/comments`,
    body: { body: `${input.body}\n\n${marker}` },
  });
  return 'posted';
}

/** The reply text for a request that did not start. */
export function startFailureReply(
  command: string,
  failure: GateFailure,
): string {
  const name = command === '' ? 'The review' : inlineCode(command);
  return failure.route === 'command'
    ? `${name} did not start: ${failure.detail}`
    : `${name} did not start: this workflow's settings are misconfigured (${failure.detail}). Nothing was wrong with your command; a maintainer needs to fix the workflow file.`;
}

export type AcknowledgeOutcome =
  | {
      status: 'failed';
      failure: GateFailure;
      text: string;
      reply: 'posted' | 'already-posted' | 'none';
    }
  | { status: 'accepted'; record: RequestRecord; text: string };

/** Step 3: consume the label, then reply and stop, or accept and bind. */
export async function acknowledgeRequest(input: {
  github: GithubClient;
  repository: string;
  runId: string;
  authorized: Authorized;
  configured: ConfigureOutcome;
  /** Reply to a failed comment or dispatch command (false for local runs). */
  reply: boolean;
  /** React with `eyes` and remove the trigger label (false for local runs). */
  acknowledge: boolean;
  publisherLogin: string;
}): Promise<AcknowledgeOutcome> {
  const { request, pullRequest } = input.authorized;
  const repo = repositoryPath(input.repository);

  // The label is consumed once the request is authorized, whatever happens
  // next, so adding it again starts a new request.
  if (
    input.acknowledge &&
    request.trigger === 'label' &&
    request.label !== null
  )
    await input.github.send(
      {
        method: 'DELETE',
        path: `${repo}/issues/${request.prNumber}/labels/${encodeURIComponent(request.label)}`,
      },
      [200, 204, 404],
    );

  if (input.configured.status === 'failed') {
    const failure = input.configured.failure;
    const command =
      request.trigger === 'label'
        ? ''
        : commandToken(request.commandText ?? '');
    const text = startFailureReply(command, failure);
    // Labels carry no command, so only commands get a reply.
    const reply =
      !input.reply || request.trigger === 'label'
        ? 'none'
        : await replyOnce({
            github: input.github,
            repository: input.repository,
            prNumber: request.prNumber,
            key: replyKey(input.repository, request, input.runId),
            body: text,
            publisherLogin: input.publisherLogin,
          });
    return { status: 'failed', failure, text, reply };
  }

  const config = input.configured.config;
  // The reaction only tells the requester the run started, so a failure to
  // add it never drops an authorized review.
  if (
    input.acknowledge &&
    request.trigger === 'comment' &&
    request.commentId !== null
  )
    try {
      await input.github.send(
        {
          method: 'POST',
          path: `${repo}/issues/comments/${request.commentId}/reactions`,
          body: { content: 'eyes' },
        },
        [200, 201],
      );
    } catch (error) {
      if (!isReviewError(error)) throw error;
    }
  const record: RequestRecord = {
    version: 1,
    request_id: requestId({
      repository: input.repository,
      request,
      runId: input.runId,
      headSha: pullRequest.headSha,
      config,
    }),
    repository: input.repository,
    pr_number: request.prNumber,
    trigger: request.trigger,
    base_ref: pullRequest.baseRef,
    base_sha: pullRequest.baseSha,
    merge_base_sha: input.authorized.mergeBaseSha,
    head_sha: pullRequest.headSha,
    config,
    pr: { title: pullRequest.title, body: pullRequest.body },
  };
  const text = [
    '## agent-ci PR review accepted',
    '',
    `- Mode: \`${config.mode}\``,
    `- Head: \`${record.head_sha.slice(0, 12)}\``,
    `- Primary reviewer: \`${config.primary.model}\``,
    `- Second reviewer: ${config.second.enabled ? `\`${config.second.model}\`` : 'off'}`,
    `- Adjudicator: ${config.adjudicator.enabled ? `\`${config.adjudicator.model}\`` : 'off'}`,
    `- Request: \`${record.request_id.slice(0, 16)}\``,
  ].join('\n');
  return { status: 'accepted', record, text };
}

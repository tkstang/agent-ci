import {
  inlineCode,
  isCommandError,
  parseReviewCommand,
  resolveRequestConfig,
} from '@agent-ci/review/command.js';
import { describe, expect, it } from 'vitest';

const DEFAULTS = {
  reviewer_model: 'claude-haiku-4-5',
  second_reviewer: false,
  second_reviewer_model: 'grok-4.7',
  adjudicator: false,
  adjudicator_model: 'claude-haiku-4-5',
};

function rejected(body: string): string {
  try {
    parseReviewCommand(body);
  } catch (error) {
    expect(isCommandError(error)).toBe(true);
    return (error as Error).message;
  }
  throw new Error('expected a command error');
}

describe('parseReviewCommand', () => {
  it('accepts a bare command and ignores text that is not a command', () => {
    expect(parseReviewCommand('/agent-ci-review')).toEqual({
      kind: 'command',
      command: '/agent-ci-review',
      mode: 'review',
      options: {},
      instruction: '',
    });
    for (const body of [
      'please /agent-ci-review',
      '/pntr-review',
      '/agent-ci-reviewer',
      '/agent-ci-verify-reviewer',
      42,
    ])
      expect(parseReviewCommand(body)).toEqual({ kind: 'not-command' });
  });

  it('parses the verify-review command with options and an instruction', () => {
    expect(
      parseReviewCommand(
        '/agent-ci-verify-review reviewer_model=x check tests',
      ),
    ).toEqual({
      kind: 'command',
      command: '/agent-ci-verify-review',
      mode: 'verify-review',
      options: { reviewer_model: 'x' },
      instruction: 'check tests',
    });
  });

  it('parses leading options, then the instruction (with -- and later lines)', () => {
    expect(
      parseReviewCommand(
        '/agent-ci-review reviewer_model=grok-4.7\tsecond_reviewer=on focus on x=1\n  keep indent',
      ),
    ).toMatchObject({
      options: { reviewer_model: 'grok-4.7', second_reviewer: true },
      instruction: 'focus on x=1\n  keep indent',
    });
    expect(
      parseReviewCommand('/agent-ci-review -- reviewer_model=x is text'),
    ).toMatchObject({ options: {}, instruction: 'reviewer_model=x is text' });
  });

  it.each([
    ['/agent-ci-review model=x', 'is not an option'],
    ['/agent-ci-review reviewer_model=a reviewer_model=b', 'more than once'],
    ['/agent-ci-review reviewer_model=', 'empty value'],
    ['/agent-ci-review =x', 'no option name'],
    ['/agent-ci-review adjudicator=maybe', 'not a valid switch'],
    [
      '/agent-ci-review adjudicator=off adjudicator_model=claude-haiku-4-5',
      'turns the pass off',
    ],
    ['/agent-ci-review reviewer_model=bad!name', 'is not a model name'],
    [
      '/agent-ci-review second_reviewer_model=opus[effort=high]',
      'is not a model name',
    ],
    ['/agent-ci-review reviewer_model=a\u200bb', 'invisible or control'],
    ['/agent-ci-review\u00a0reviewer_model=a', 'invisible or control'],
  ])('rejects %j', (body, message) => {
    expect(rejected(body)).toContain(message);
  });

  it('rejects over-long comments and instructions instead of truncating', () => {
    expect(rejected(`/agent-ci-review ${'x'.repeat(17_000)}`)).toContain(
      'longer than 16384 bytes',
    );
    expect(rejected(`/agent-ci-review ${'x'.repeat(2001)}`)).toContain(
      'longer than 2000 characters',
    );
  });

  it('renders commenter tokens as inert code spans', () => {
    expect(inlineCode('a`b')).toBe('``a`b``');
    expect(inlineCode('x\u200by')).toBe('`x\\u{200b}y`');
  });
});

describe('resolveRequestConfig', () => {
  it('applies the workflow settings when the command names nothing', () => {
    expect(
      resolveRequestConfig({ mode: 'review', defaults: DEFAULTS }),
    ).toEqual({
      version: 1,
      mode: 'review',
      primary: { model: 'claude-haiku-4-5' },
      second: { enabled: false, model: 'grok-4.7' },
      adjudicator: { enabled: false, model: 'claude-haiku-4-5' },
      instruction: '',
    });
  });

  it('turns a pass on with a named model and off with an explicit off', () => {
    const config = resolveRequestConfig({
      mode: 'review',
      defaults: { ...DEFAULTS, adjudicator: true },
      options: { second_reviewer_model: 'glm-5.3-flash', adjudicator: false },
    });
    expect(config.second).toEqual({ enabled: true, model: 'glm-5.3-flash' });
    expect(config.adjudicator.enabled).toBe(false);
  });

  it('rejects a model name outside the routing-table grammar', () => {
    expect(() =>
      resolveRequestConfig({
        mode: 'review',
        defaults: DEFAULTS,
        options: { reviewer_model: 'opus[effort=high]' },
      }),
    ).toThrow(expect.objectContaining({ code: 'E_REVIEW_REQUEST' }));
  });
});

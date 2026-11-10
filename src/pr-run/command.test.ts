import { describe, expect, it } from 'vitest';

import { parsePrRunCommand } from './command.js';

describe('parsePrRunCommand', () => {
  it.each([
    ['/agent-ci --model-profile=cost fix the build', 'cost'],
    ['@agent-ci --model-profile balance fix the build', 'balance'],
    ['/agent-ci\n--model-profile=intelligence\nfix the build', 'intelligence'],
  ])('selects a leading model profile in %s', (body, modelProfile) => {
    expect(parsePrRunCommand(body)).toEqual({
      ok: true,
      value: { modelProfile, prompt: 'fix the build' },
    });
  });

  it.each([
    [
      '/agent-ci use $fix-ci then $address-feedback',
      'use $fix-ci then $address-feedback',
    ],
    ['/agent-ci /fix-ci --model-profile=cost', '/fix-ci --model-profile=cost'],
    [
      '/agent-ci preserve PHP $response\n--model=balance',
      'preserve PHP $response\n--model=balance',
    ],
    [
      '/agent-ci -- --model-profile=cost is task text',
      '--model-profile=cost is task text',
    ],
    ['/agent-ci -- --unknown option', '--unknown option'],
  ])(
    'preserves prompt text and leaves the default unspecified in %s',
    (body, prompt) => {
      expect(parsePrRunCommand(body)).toEqual({ ok: true, value: { prompt } });
    },
  );

  it('ends runner options before an option-shaped task after a selected profile', () => {
    expect(
      parsePrRunCommand('/agent-ci --model-profile=balance -- --model=custom'),
    ).toEqual({
      ok: true,
      value: { modelProfile: 'balance', prompt: '--model=custom' },
    });
  });

  it.each([
    '/agent-ci --model-profile=unknown fix it',
    '/agent-ci --model-profile= fix it',
    '/agent-ci --model-profile',
    '/agent-ci --model-profile=cost',
    '/agent-ci --model-profile=cost --model-profile=balance fix it',
    '/agent-ci --model=balance fix it',
    '/agent-ci --model balance fix it',
    '/agent-ci --route=paid fix it',
    '/agent-ci --',
    '/agent-ci',
  ])('refuses malformed options or a missing task in %s', (body) => {
    expect(parsePrRunCommand(body)).toMatchObject({
      ok: false,
      code: 'E_PR_RUN_REQUEST',
    });
  });

  it.each([
    null,
    '/agent-ci-review fix it',
    'please /agent-ci fix it',
    '@agent-cidental',
  ])('ignores unrelated input %s', (body) => {
    expect(parsePrRunCommand(body)).toEqual({ ok: true, value: null });
  });
});

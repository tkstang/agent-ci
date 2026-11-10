import { describe, expect, it } from 'vitest';

import { parsePrRunModelProfiles, selectPrRunModel } from './profiles.js';

describe('PR run model profile configuration', () => {
  it('uses the required default and replaces its complete selection for a profile', () => {
    const parsed = parsePrRunModelProfiles(`balance:
  model: gpt-6.1-sol-high
  harness: codex
cost:
  model: cheap-model
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const config = {
      defaultModel: {
        model: 'claude-opus-5-5-high',
        harness: 'claude' as const,
        route: 'opus-personal',
      },
      profiles: parsed.value,
      allowedModels: [
        'claude-opus-5-5-high',
        'gpt-6.1-sol-high',
        'cheap-model',
      ],
    };
    expect(selectPrRunModel(config)).toEqual({
      ok: true,
      value: config.defaultModel,
    });
    expect(
      selectPrRunModel({ ...config, requestedProfile: 'balance' }),
    ).toEqual({
      ok: true,
      value: { model: 'gpt-6.1-sol-high', harness: 'codex' },
    });
    expect(selectPrRunModel({ ...config, requestedProfile: 'cost' })).toEqual({
      ok: true,
      value: { model: 'cheap-model' },
    });
  });

  it.each([
    'balance: [',
    'null',
    '[]',
    'custom: {model: fake-edit}',
    'balance: {model: ""}',
    'balance: {model: "two models"}',
    'balance: {model: fake-edit, harness: arbitrary}',
    'balance: {model: fake-edit, credentials: [MY_SECRET]}',
    'balance: {harness: codex}',
    'balance: {model: fake-edit, route: ""}',
    'balance: {model: fake-edit}\nbalance: {model: fake-echo}',
  ])('refuses malformed or unsupported caller configuration: %s', (config) => {
    expect(parsePrRunModelProfiles(config)).toMatchObject({
      ok: false,
      code: 'E_PR_RUN_REQUEST',
    });
  });

  it('allows omitted profiles but refuses an explicitly requested unconfigured name', () => {
    expect(parsePrRunModelProfiles('')).toEqual({ ok: true, value: {} });
    expect(
      selectPrRunModel({
        defaultModel: { model: 'fake-edit' },
        profiles: {},
        requestedProfile: 'intelligence',
        allowedModels: ['fake-edit'],
      }),
    ).toMatchObject({ ok: false, code: 'E_PR_RUN_REQUEST' });
  });

  it.each(['default', 'profile'])(
    'requires every configured %s model to be allowlisted even when unused',
    (kind) => {
      expect(
        selectPrRunModel({
          defaultModel: { model: kind === 'default' ? 'unlisted' : 'listed' },
          profiles: {
            cost: { model: kind === 'profile' ? 'unlisted' : 'listed' },
          },
          allowedModels: ['listed'],
        }),
      ).toMatchObject({ ok: false, code: 'E_PR_RUN_REQUEST' });
    },
  );
});

import {
  extractStructuredResult,
  parseJsonPayload,
  stripJsonFence,
} from '@agent-ci/contracts/final-answer.js';
import { describe, expect, it } from 'vitest';

describe('final-answer parsing', () => {
  it('strips a json fence', () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFence('  {"a":1} ')).toBe('{"a":1}');
  });

  it('parses JSON surrounded by prose', () => {
    expect(parseJsonPayload('Here you go: {"ok":true} thanks')).toEqual({
      ok: true,
      value: { ok: true },
    });
  });

  it('fails with E_INVALID_RUN_RESULT on non-JSON', () => {
    expect(parseJsonPayload('no json here')).toMatchObject({
      ok: false,
      code: 'E_INVALID_RUN_RESULT',
    });
  });

  it('passes through an already-parsed structured object', () => {
    const value = { ok: true, status: 'no-op' };
    expect(extractStructuredResult(value)).toEqual({ ok: true, value });
  });

  it('unwraps a result/text/message wrapper once', () => {
    expect(
      extractStructuredResult(
        '{"result":"{\\"ok\\":true,\\"status\\":\\"no-op\\"}"}',
      ),
    ).toEqual({ ok: true, value: { ok: true, status: 'no-op' } });
    expect(
      extractStructuredResult({ text: '```json\n{"ok":false}\n```' }),
    ).toEqual({ ok: true, value: { ok: false } });
  });

  it('does not unwrap a RunResult that carries a message field', () => {
    const value = { ok: true, status: 'no-op', message: 'hello' };
    expect(extractStructuredResult(value)).toEqual({ ok: true, value });
  });
});

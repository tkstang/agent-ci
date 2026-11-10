import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { answer } from './agent-ci-command-fixture.mjs';

test('addresses review feedback', () => assert.equal(answer(), 42));
test('preserves both conflict inputs and the base-only addition', () => {
  const text = readFileSync('agent-ci-command-conflict.txt', 'utf8');
  assert.match(text, /base wording/);
  assert.match(text, /feature wording/);
  assert.doesNotMatch(text, /^(<<<<<<<|=======|>>>>>>>)/m);
  assert.equal(readFileSync('agent-ci-command-base-only.txt', 'utf8'), 'base addition\n');
});
test('executes both installed skills in order', () => {
  assert.equal(readFileSync('agent-ci-skill-order.txt', 'utf8'), 'first\nsecond\n');
});

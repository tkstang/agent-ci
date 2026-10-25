import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RunLog } from '@agent-ci/run/run-log.js';
import { describe, expect, it } from 'vitest';

const SECRET = 'synthetic-secret-value-0003';

describe('RunLog', () => {
  it('writes one JSON record per line and redacts records that copy a secret', async () => {
    const log = new RunLog([SECRET], () => new Date('2026-10-25T00:00:00Z'));
    log.add('run.start', { route: 'fake-echo' });
    log.add('attempt', { message: `boom ${SECRET}` });
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-log-'));
    const file = path.join(dir, 'run-log.jsonl');
    await log.write(file);
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain(SECRET);
    expect(
      text
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        at: '2026-10-25T00:00:00.000Z',
        event: 'run.start',
        route: 'fake-echo',
      },
      {
        at: '2026-10-25T00:00:00.000Z',
        event: 'attempt',
        code: 'E_SECRET_COPY',
        message: 'log record redacted',
      },
    ]);
  });
});

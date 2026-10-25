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

  it('re-checks earlier records when a secret is learned later', async () => {
    const later = 'synthetic-later-secret-0004';
    const log = new RunLog([], () => new Date('2026-10-25T00:00:00Z'));
    log.add('attempt', { message: `saw ${later}` });
    expect(JSON.stringify(log.records)).toContain(later);
    log.addSecrets([later]);
    expect(JSON.stringify(log.records)).not.toContain(later);
    expect(log.records[0]).toMatchObject({ code: 'E_SECRET_COPY' });
  });
});

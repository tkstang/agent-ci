import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { containsSecret } from '@agent-ci/contracts/secret-guard.js';

/**
 * The JSONL run log (`run-log.jsonl`), after pntr's `writeRunLog`: one JSON
 * record per line. A record that would copy a credential value is replaced
 * by a redaction marker instead of being written.
 */
export class RunLog {
  readonly #records: Record<string, unknown>[] = [];
  readonly #secrets: readonly string[];
  readonly #now: () => Date;

  constructor(secrets: readonly string[], now: () => Date = () => new Date()) {
    this.#secrets = secrets;
    this.#now = now;
  }

  add(event: string, fields: Record<string, unknown> = {}): void {
    const record = { at: this.#now().toISOString(), event, ...fields };
    this.#records.push(
      containsSecret(record, this.#secrets)
        ? {
            at: record.at,
            event,
            code: 'E_SECRET_COPY',
            message: 'log record redacted',
          }
        : record,
    );
  }

  get records(): readonly Record<string, unknown>[] {
    return this.#records;
  }

  async write(filePath: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const lines = this.#records.map((record) => JSON.stringify(record));
    await writeFile(
      filePath,
      lines.length === 0 ? '' : `${lines.join('\n')}\n`,
    );
  }
}

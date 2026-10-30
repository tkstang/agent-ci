import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { containsSecret } from '@agent-ci/contracts/secret-guard.js';
import { writeOwnedFile } from '@agent-ci/files.js';

/**
 * The JSONL run log (`run-log.jsonl`): one JSON
 * record per line. A record that would copy a credential value is replaced
 * by a redaction marker instead of being written.
 *
 * The secret set can grow during a run (a harness may refresh a login), so
 * records are checked against the CURRENT set whenever they are read or
 * written, not only when they were added.
 */
export class RunLog {
  readonly #records: Record<string, unknown>[] = [];
  readonly #secrets: Set<string>;
  readonly #now: () => Date;
  #withhold = false;

  constructor(secrets: readonly string[], now: () => Date = () => new Date()) {
    this.#secrets = new Set(secrets.filter((secret) => secret !== ''));
    this.#now = now;
  }

  /** Guard every record (past and future) against more secret values. */
  addSecrets(values: readonly string[]): void {
    for (const value of values) if (value !== '') this.#secrets.add(value);
  }

  /**
   * The secret set can no longer be trusted to be complete (the credential
   * guard failed): withhold every free-text `message` field from now on,
   * including in records already added.
   */
  withholdFreeText(): void {
    this.#withhold = true;
  }

  add(event: string, fields: Record<string, unknown> = {}): void {
    this.#records.push({ at: this.#now().toISOString(), event, ...fields });
  }

  #guard(input: Record<string, unknown>): Record<string, unknown> {
    const record =
      this.#withhold && typeof input.message === 'string'
        ? { ...input, message: '[withheld: credential guard incomplete]' }
        : input;
    return containsSecret(record, [...this.#secrets])
      ? {
          at: record.at,
          event: record.event,
          code: 'E_SECRET_COPY',
          message: 'log record redacted',
        }
      : record;
  }

  get records(): readonly Record<string, unknown>[] {
    return this.#records.map((record) => this.#guard(record));
  }

  async write(filePath: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const lines = this.records.map((record) => JSON.stringify(record));
    await writeOwnedFile(
      filePath,
      lines.length === 0 ? '' : `${lines.join('\n')}\n`,
      0o644,
    );
  }
}

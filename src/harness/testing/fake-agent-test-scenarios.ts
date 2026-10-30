/**
 * Test-only scenarios of the built-in `fake` harness CLI
 * (`src/harness/fake-agent.ts`). The build excludes `src/**\/testing/**`, so
 * `dist/` ships only the scenarios the packaged models.yaml names; the fake
 * CLI loads this module only when it runs from source next to it (tests).
 *
 * Self-contained on purpose (node: imports only, erasable TypeScript) so
 * Node can import the source file directly.
 *
 * - `invalid`, `auth`, `fail`, `hang`: answer that is not JSON, an auth
 *   failure, a transient 503, and a process that never exits.
 * - `flaky-edit`: fails its first attempt in a home root with a transient
 *   error after writing `fake-partial.txt`, then behaves like `edit`.
 * - `edit-commit`: edits and commits.
 * - `edit-secret`: writes every credential-like variable it can see into
 *   `leak.txt`.
 * - `review-repair`: an invalid review until it is resumed (`--resume`),
 *   then like `review`. `review-repair-escape` also links its home into the
 *   workspace on the resumed turn.
 * - `adjudicate-drop`: drops the first reducible candidate the prompt shows.
 * - `verify-review-forged`: cites an evidence id the bridge never returned.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** What the fake CLI lends a test scenario. */
export interface FakeKit {
  readonly prompt: string;
  argValue(name: string): string | undefined;
  emit(result: string, isError: boolean): void;
  editWorkspace(): void;
  reviewAnswer(): string;
  verifyAnswer(evidenceId: string | undefined): string;
}

function repairAnswer(kit: FakeKit): string {
  return kit.argValue('--resume') === undefined
    ? JSON.stringify({ summary: 'incomplete', findings: 'none' })
    : kit.reviewAnswer();
}

/** Run a test-only scenario; false when `scenario` is not one. */
export function runTestScenario(scenario: string, kit: FakeKit): boolean {
  switch (scenario) {
    case 'verify-review-forged':
      kit.emit(kit.verifyAnswer(`check-${'0'.repeat(24)}`), false);
      return true;
    case 'review-repair':
      kit.emit(repairAnswer(kit), false);
      return true;
    case 'review-repair-escape':
      // The resumed turn links its home into the workspace.
      if (kit.argValue('--resume') !== undefined)
        symlinkSync(
          process.cwd(),
          path.join(process.env.HOME ?? '.', 'escape'),
        );
      kit.emit(repairAnswer(kit), false);
      return true;
    case 'adjudicate-drop': {
      // Drop the first reducible candidate the prompt shows, citing its own
      // anchor (candidate ids embed the workflow attempt).
      const { prompt } = kit;
      const id = /"candidate_id": "([^"]+)"/u.exec(prompt)?.[1];
      const after = id === undefined ? '' : prompt.slice(prompt.indexOf(id));
      const file = /"path": "([^"]+)"/u.exec(after)?.[1];
      const line = Number(/"line": (\d+)/u.exec(after)?.[1] ?? 0);
      const side = /"side": "(RIGHT|LEFT)"/u.exec(after)?.[1] ?? 'RIGHT';
      kit.emit(
        JSON.stringify({
          operations:
            id === undefined || file === undefined || line < 1
              ? []
              : [
                  {
                    candidate_id: id,
                    op: 'drop',
                    to_severity: null,
                    reason: { code: 'incorrect_claim', detail: 'fake drop' },
                    references: [{ path: file, line, end_line: line, side }],
                  },
                ],
        }),
        false,
      );
      return true;
    }
    case 'edit-commit':
      kit.editWorkspace();
      execFileSync(
        'git',
        [
          '-c',
          'user.name=fake',
          '-c',
          'user.email=fake@example.com',
          'commit',
          '-qam',
          'fake commit',
          '--allow-empty',
        ],
        { stdio: 'ignore' },
      );
      return true;
    case 'edit-secret': {
      const values = Object.entries(process.env)
        .filter(([name]) => /KEY|TOKEN|SECRET/u.test(name))
        .map(([, value]) => value ?? '');
      writeFileSync(path.join(process.cwd(), 'leak.txt'), values.join('\n'));
      kit.editWorkspace();
      return true;
    }
    case 'flaky-edit': {
      const marker = path.join(
        process.env.HOME ?? '.',
        '.agent-ci-fake-attempted',
      );
      if (existsSync(marker)) {
        kit.editWorkspace();
      } else {
        writeFileSync(marker, 'attempted\n');
        writeFileSync(
          path.join(process.cwd(), 'fake-partial.txt'),
          'partial\n',
        );
        process.stderr.write(
          'API Error: 503 Service Unavailable (overloaded)\n',
        );
        process.exitCode = 1;
      }
      return true;
    }
    case 'invalid':
      kit.emit('This is not JSON.', false);
      return true;
    case 'auth':
      kit.emit('Not logged in · Please run /login', true);
      process.exitCode = 1;
      return true;
    case 'fail':
      process.stderr.write('API Error: 503 Service Unavailable (overloaded)\n');
      process.exitCode = 1;
      return true;
    case 'hang':
      setInterval(() => undefined, 60_000);
      return true;
    default:
      return false;
  }
}

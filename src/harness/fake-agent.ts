#!/usr/bin/env node
/**
 * The built-in `fake` harness CLI: no model, no network, no credential. It
 * answers like `claude -p --output-format json` so the whole run path
 * (spawn, environment isolation, extraction, contracts, run log) can be
 * exercised for free, locally and on Actions runners.
 *
 * Self-contained on purpose (node: imports only, erasable TypeScript) so Node
 * can run the source file directly in tests and `dist/` in production.
 *
 * Usage: fake-agent --scenario <name> [--resume <session>] -- <prompt>
 *
 * Scenarios: echo, edit, flaky-edit, invalid, fail, auth, hang, review,
 * review-repair, adjudicate.
 *
 * `edit` writes `agent-ci-fake-edit.md` in the working directory (content
 * derived from the prompt only, so reruns are identical). `flaky-edit` fails
 * its first attempt in a home root with a transient error after writing
 * `fake-partial.txt`, then behaves like `edit`. Test-only: `edit-commit`
 * edits and commits; `edit-secret` writes every credential-like variable it
 * can see into `leak.txt`.
 *
 * `review` answers a PR-review pass: one `medium` finding on the first added
 * line of `.agent-ci-review/diff.patch` (quoting it as evidence), or none.
 * `review-repair` answers with an invalid review until it is resumed
 * (`--resume`), then like `review`. `adjudicate` keeps every finding.
 * Test-only: `review-repair-escape` links its home into the workspace on
 * the resumed turn.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  fstatSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function promptText(): string {
  const separator = process.argv.indexOf('--');
  return separator === -1 ? '' : process.argv.slice(separator + 1).join(' ');
}

function stdinIsDevNull(): boolean {
  try {
    const stdin = fstatSync(0);
    const devNull = statSync('/dev/null');
    return stdin.rdev === devNull.rdev && stdin.ino === devNull.ino;
  } catch {
    return false;
  }
}

function emit(result: string, isError: boolean): void {
  process.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: isError,
      result,
      session_id: 'fake-session',
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
    })}\n`,
  );
}

const scenario = argValue('--scenario') ?? 'echo';
const prompt = promptText();

function editWorkspace(): void {
  const digest = createHash('sha256').update(prompt).digest('hex');
  writeFileSync(
    path.join(process.cwd(), 'agent-ci-fake-edit.md'),
    `# agent-ci fake edit\n\nWritten by the credential-free fake harness (no model was called).\nPrompt sha256: ${digest.slice(0, 16)}\n`,
  );
  emit(
    JSON.stringify({
      summary:
        'Fake harness edited agent-ci-fake-edit.md (no model was called).',
      report: {
        title: 'agent-ci fake harness edit',
        markdown: `- Wrote \`agent-ci-fake-edit.md\`\n- stdin is /dev/null: ${stdinIsDevNull()}`,
      },
      artifacts: [],
      changedFiles: [],
      errors: [],
    }),
    false,
  );
}

/** The first added line of the review diff, if any. */
function firstAddedLine():
  | { path: string; line: number; text: string }
  | undefined {
  let text: string;
  try {
    text = readFileSync(
      path.join(process.cwd(), '.agent-ci-review', 'diff.patch'),
      'utf8',
    );
  } catch {
    return undefined;
  }
  let file: string | undefined;
  let next = 0;
  let inHunk = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/u, '');
    if (line.startsWith('diff --git ')) {
      file = undefined;
      inHunk = false;
    } else if (!inHunk && line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : undefined;
    } else if (line.startsWith('@@ ')) {
      const match = /\+(\d+)/u.exec(line);
      next = Number(match?.[1] ?? 0);
      inHunk = file !== undefined;
    } else if (inHunk && line.startsWith('+')) {
      if (file !== undefined && line.slice(1).trim() !== '')
        return { path: file, line: next, text: line.slice(1) };
      next += 1;
    } else if (inHunk && (line.startsWith(' ') || line === '')) {
      next += 1;
    }
  }
  return undefined;
}

function reviewAnswer(): string {
  const added = firstAddedLine();
  const findings =
    added === undefined
      ? []
      : [
          {
            id: 'f1',
            severity: 'medium',
            category: 'maintainability',
            rule_id: null,
            title: 'Fake finding on the first added line (no model was called)',
            body: 'The credential-free fake harness reports the first added line of the diff so the findings gate and the publisher can be exercised.',
            path: added.path,
            line: added.line,
            end_line: added.line,
            side: 'RIGHT',
            original_code: added.text,
            suggestion: null,
            evidence: [
              {
                kind: 'code',
                path: added.path,
                line: added.line,
                end_line: added.line,
                side: 'RIGHT',
                quote: added.text,
              },
            ],
          },
        ];
  return JSON.stringify({
    summary: `Fake review (no model was called): ${findings.length} finding(s).`,
    findings,
  });
}

switch (scenario) {
  case 'review':
    emit(reviewAnswer(), false);
    break;
  case 'review-repair':
    emit(
      argValue('--resume') === undefined
        ? JSON.stringify({ summary: 'incomplete', findings: 'none' })
        : reviewAnswer(),
      false,
    );
    break;
  case 'adjudicate':
    emit(JSON.stringify({ operations: [] }), false);
    break;
  case 'review-repair-escape':
    // Test-only: the resumed turn links its home into the workspace.
    if (argValue('--resume') !== undefined)
      symlinkSync(process.cwd(), path.join(process.env.HOME ?? '.', 'escape'));
    emit(
      argValue('--resume') === undefined
        ? JSON.stringify({ summary: 'incomplete', findings: 'none' })
        : reviewAnswer(),
      false,
    );
    break;
  case 'echo': {
    const credentialLike = Object.keys(process.env).filter((name) =>
      /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/u.test(name),
    );
    const digest = createHash('sha256').update(prompt).digest('hex');
    const facts = [
      `- Prompt bytes: ${Buffer.byteLength(prompt)}`,
      `- Prompt sha256: ${digest.slice(0, 16)}`,
      `- stdin is /dev/null: ${stdinIsDevNull()}`,
      `- Credential-like variables visible: ${credentialLike.length}`,
      `- HOME under an agent-ci home root: ${String(process.env.HOME ?? '').endsWith('/home')}`,
    ];
    emit(
      JSON.stringify({
        summary: 'Fake harness run (no model was called).',
        report: {
          title: 'agent-ci fake harness',
          markdown: facts.join('\n'),
        },
        artifacts: [],
        changedFiles: [],
        errors: [],
      }),
      false,
    );
    break;
  }
  case 'edit':
    editWorkspace();
    break;
  case 'edit-commit':
    editWorkspace();
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
    break;
  case 'edit-secret': {
    const values = Object.entries(process.env)
      .filter(([name]) => /KEY|TOKEN|SECRET/u.test(name))
      .map(([, value]) => value ?? '');
    writeFileSync(path.join(process.cwd(), 'leak.txt'), values.join('\n'));
    editWorkspace();
    break;
  }
  case 'flaky-edit': {
    const marker = path.join(
      process.env.HOME ?? '.',
      '.agent-ci-fake-attempted',
    );
    if (existsSync(marker)) {
      editWorkspace();
    } else {
      writeFileSync(marker, 'attempted\n');
      writeFileSync(path.join(process.cwd(), 'fake-partial.txt'), 'partial\n');
      process.stderr.write('API Error: 503 Service Unavailable (overloaded)\n');
      process.exitCode = 1;
    }
    break;
  }
  case 'invalid':
    emit('This is not JSON.', false);
    break;
  case 'auth':
    emit('Not logged in · Please run /login', true);
    process.exitCode = 1;
    break;
  case 'fail':
    process.stderr.write('API Error: 503 Service Unavailable (overloaded)\n');
    process.exitCode = 1;
    break;
  case 'hang':
    setInterval(() => undefined, 60_000);
    break;
  default:
    process.stderr.write(`unknown fake scenario: ${scenario}\n`);
    process.exitCode = 2;
}

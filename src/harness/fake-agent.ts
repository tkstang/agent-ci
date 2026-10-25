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
 * Usage: fake-agent --scenario <echo|edit|flaky-edit|invalid|fail|auth|hang> -- <prompt>
 *
 * `edit` writes `agent-ci-fake-edit.md` in the working directory (content
 * derived from the prompt only, so reruns are identical). `flaky-edit` fails
 * its first attempt in a home root with a transient error after writing
 * `fake-partial.txt`, then behaves like `edit`. Test-only: `edit-commit`
 * edits and commits; `edit-secret` writes every credential-like variable it
 * can see into `leak.txt`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, fstatSync, statSync, writeFileSync } from 'node:fs';
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

switch (scenario) {
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

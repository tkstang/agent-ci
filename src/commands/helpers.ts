import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseFlags, required } from '@agent-ci/commands/flags.js';
import { appendGithubOutput } from '@agent-ci/commands/github.js';
import type { CommandSpec } from '@agent-ci/commands/types.js';
import { CliError } from '@agent-ci/errors.js';
import { PACKAGE_ROOT } from '@agent-ci/paths.js';

const USAGE = `agent-ci helpers bundle — pack the built CLI for a job without the helper token.

  agent-ci helpers bundle --out <file.tgz> [--github-output]

Packs dist/, package.json, models.yaml and the runtime dependencies (each
must itself have none) into one gzip tarball. pr-review.yml's gate job
uploads it, and the credential-free verify job downloads it by artifact id,
checks its sha256 and runs node dist/cli.js from it: that job runs pull
request code, so it never receives a source credential or a model secret.
--github-output writes sha256=<hex> to $GITHUB_OUTPUT.`;

type PackageJson = { dependencies?: Record<string, string> };

async function readPackage(dir: string): Promise<PackageJson> {
  return JSON.parse(
    await readFile(path.join(dir, 'package.json'), 'utf8'),
  ) as PackageJson;
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function tar(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' },
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`tar exited ${code}: ${stderr.trim()}`)),
    );
  });
}

/** Stage and pack the helpers; returns the tarball's sha256. */
export async function bundleHelpers(
  out: string,
  root: string = PACKAGE_ROOT,
): Promise<string> {
  const stage = await mkdtemp(path.join(os.tmpdir(), 'agent-ci-bundle-'));
  try {
    await cp(path.join(root, 'dist'), path.join(stage, 'dist'), {
      recursive: true,
      verbatimSymlinks: true,
    });
    for (const file of ['package.json', 'models.yaml'])
      await cp(path.join(root, file), path.join(stage, file));
    const dependencies = Object.keys(
      (await readPackage(root)).dependencies ?? {},
    );
    for (const name of dependencies) {
      const source = path.join(root, 'node_modules', name);
      const nested = (await readPackage(source)).dependencies ?? {};
      if (Object.keys(nested).length > 0)
        throw new CliError(
          'E_INVALID_INPUT',
          `runtime dependency ${name} has dependencies of its own; the helper bundle carries dependency-free packages only`,
        );
      // pnpm links node_modules/<name> into its store: copy the contents.
      await cp(source, path.join(stage, 'node_modules', name), {
        recursive: true,
        dereference: true,
      });
    }
    await mkdir(path.dirname(out), { recursive: true });
    await tar(['-czf', out, '-C', stage, '.']);
    return await sha256File(out);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export const helpersCommand: CommandSpec = {
  name: 'helpers',
  summary: 'Pack the built CLI for the credential-free verify job',
  usage: USAGE,
  async run(argv, context) {
    const [action, ...rest] = argv;
    if (action !== 'bundle')
      throw new CliError(
        'E_INVALID_INPUT',
        `unknown helpers action: ${action ?? '(none)'}`,
        { hint: USAGE },
      );
    const flags = parseFlags(
      rest,
      { out: { type: 'string' }, 'github-output': { type: 'boolean' } },
      USAGE,
    );
    const out = path.resolve(context.cwd, required(flags.out, '--out'));
    const sha256 = await bundleHelpers(out);
    if (flags['github-output'] === true)
      await appendGithubOutput(context.env, { sha256 });
    return { out, sha256 };
  },
};

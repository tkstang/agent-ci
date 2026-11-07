import { execFileSync } from 'node:child_process';

import { proveConformanceGraph } from './graph.js';

const git = (args: string[]) =>
  execFileSync('git', args, {
    maxBuffer: 64 * 1024,
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  });

// Maintainer preparation command, deliberately outside the public agent CLI.
// Only an exact commit object is accepted; worktree files and movable refs are
// never the source of the proof. Each Git read is bounded and read-only.
try {
  const [revision, ...extra] = process.argv.slice(2);
  if (extra.length !== 0 || !revision || !/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error('revision refused');
  }
  if (git(['cat-file', '-t', revision]).toString('utf8').trim() !== 'commit') {
    throw new Error('revision refused');
  }
  const sources = Object.fromEntries(
    [
      '.github/workflows/agent-ci-artifact-conformance.yml',
      '.github/workflows/agent-ci-artifact-conformance-nested.yml',
      '.github/workflows/agent-ci-artifact-conformance-leaf.yml',
    ].map((file) => [
      file,
      new TextDecoder('utf-8', { fatal: true }).decode(
        git(['show', `${revision}:${file}`]),
      ),
    ]),
  );
  const proof = proveConformanceGraph(sources);
  if (!proof.ok) throw new Error('graph refused');
  process.stdout.write(
    `${JSON.stringify({ ...proof, sourceSha: revision })}\n`,
  );
} catch {
  // Git/parser errors can contain arbitrary source text. Never forward them.
  process.stdout.write('{"ok":false,"code":"E_CONFORMANCE_GRAPH"}\n');
  process.exitCode = 1;
}

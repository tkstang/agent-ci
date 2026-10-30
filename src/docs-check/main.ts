import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { checkDocs, loadDocsConfig } from './check.js';

/**
 * `pnpm docs:check`: run the docs check from the repository root and exit
 * 1 when it finds anything. Findings go to stderr, one per line.
 */
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const config = await loadDocsConfig(repoRoot);
const findings = await checkDocs({
  repoRoot,
  config,
  extraFiles: ['README.md', 'AGENTS.md'],
});
for (const finding of findings) {
  const where =
    finding.line === undefined
      ? finding.path
      : `${finding.path}:${finding.line}`;
  process.stderr.write(`${where}  ${finding.rule}  ${finding.message}\n`);
}
process.stdout.write(
  `docs:check: ${findings.length === 0 ? 'ok' : `${findings.length} finding(s)`} (${config.root})\n`,
);
process.exitCode = findings.length === 0 ? 0 : 1;

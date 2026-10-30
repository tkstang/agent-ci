#!/usr/bin/env node
// Fails if any CLAUDE.md / CLAUDE.local.md exists (incl. .claude/CLAUDE.md),
// matched case-insensitively. A CLAUDE.md in the working directory or any
// ancestor makes Claude Code skip every AGENTS.md beneath it, so AGENTS.md is
// the only agent instruction file. Scans the working tree from the repo root
// (not the current directory), so a gitignored CLAUDE.local.md fails too.
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set([
  'node_modules',
  '.git',
  '.worktrees',
  '.turbo',
  '.next',
  'coverage',
  'dist',
]);
const BAD = new Set(['claude.md', 'claude.local.md']);

const found = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(path);
    } else if (BAD.has(entry.name.toLowerCase())) {
      found.push(path);
    }
  }
};
walk(root);

if (found.length > 0) {
  console.error(
    'check:agents failed: AGENTS.md is the only agent instruction file. Delete:',
  );
  for (const f of found) console.error(`  ${f}`);
  console.error(
    'This scans the working tree, so a gitignored CLAUDE.local.md also fails: Claude Code would still honor it locally. Delete it too.',
  );
  process.exit(1);
}

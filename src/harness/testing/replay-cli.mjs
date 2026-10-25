#!/usr/bin/env node
// Test-only stand-in for a harness CLI. It replays recorded probe output and
// records what the adapter gave it (argv, environment, stdin, cwd) so suites
// can assert the invocation contract without a model or a credential.
//
// Usage: node replay-cli.mjs <control.json> <harness argv...>
//
// control.json:
//   { "observedPath": string,
//     "mode": "replay" | "flood",
//     "stdout": string, "stderr": string, "exitCode": number,
//     "writeArgFile": { "flag": "-o", "content": string },
//     "linkArgFile": { "flag": "-o", "target": string } }
import {
  fstatSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import process from 'node:process';

const [controlPath, ...argv] = process.argv.slice(2);
const control = JSON.parse(readFileSync(controlPath, 'utf8'));

function stdinIsDevNull() {
  try {
    const stdin = fstatSync(0);
    const devNull = statSync('/dev/null');
    return stdin.rdev === devNull.rdev && stdin.ino === devNull.ino;
  } catch {
    return false;
  }
}

const observed = {
  argv,
  env: { ...process.env },
  cwd: process.cwd(),
  stdinDevNull: stdinIsDevNull(),
};

if (control.writeArgFile) {
  const index = argv.indexOf(control.writeArgFile.flag);
  if (index !== -1 && argv[index + 1]) {
    writeFileSync(argv[index + 1], control.writeArgFile.content);
  }
}

if (control.linkArgFile) {
  const index = argv.indexOf(control.linkArgFile.flag);
  if (index !== -1 && argv[index + 1]) {
    symlinkSync(control.linkArgFile.target, argv[index + 1]);
  }
}

if (control.mode === 'flood') {
  writeFileSync(control.observedPath, JSON.stringify(observed));
  setInterval(() => process.stdout.write('x'.repeat(65536)), 1);
} else {
  writeFileSync(control.observedPath, JSON.stringify(observed));
  process.stdout.write(control.stdout ?? '');
  process.stderr.write(control.stderr ?? '');
  process.exitCode = control.exitCode ?? 0;
}

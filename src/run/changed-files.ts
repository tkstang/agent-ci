import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * Workspace changes since the run started, from `git status --porcelain -z`.
 * Paths under `excludeDirs` (agent-ci's own output) are ignored. Returns an
 * empty list outside a git repository.
 */
export function detectChangedFiles(
  cwd: string,
  excludeDirs: readonly string[] = [],
): Promise<string[]> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['status', '--porcelain', '-z', '--untracked-files=all'],
      {
        cwd,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error !== null) {
          resolve([]);
          return;
        }
        const excluded = excludeDirs
          .map((dir) => path.relative(cwd, dir))
          .filter((rel) => rel !== '' && !rel.startsWith('..'))
          .map((rel) => `${rel.split(path.sep).join('/')}/`);
        const entries = stdout.split('\0');
        const files: string[] = [];
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index] ?? '';
          if (entry.length < 4) continue;
          const status = entry.slice(0, 2);
          files.push(entry.slice(3));
          // Renames and copies carry the source path as the next entry.
          if (status.includes('R') || status.includes('C')) index += 1;
        }
        resolve(
          files.filter(
            (file) => !excluded.some((prefix) => file.startsWith(prefix)),
          ),
        );
      },
    );
    child.stdin?.end();
  });
}

import {
  parseUnifiedDiff,
  resolveAnchor,
  type SourceReader,
} from '@agent-ci/review/diff-position.js';
import { describe, expect, it } from 'vitest';

// Ported from pntr tests/workflows/pr-review-diff-position.test.ts
// (voxmedia/pntr@e438668).

// Merge-base (LEFT) and head (RIGHT) trees that the diff below describes.
const mergeBase = new Map<string, string>([
  [
    'src/a.ts',
    [
      "import x from 'x';",
      '',
      'export function one() {',
      '  return 1;',
      '}',
      '',
      'export function two() {',
      '  return 2;',
      '}',
      '',
      'export function three() {',
      '  return 3;',
      '}',
      '',
    ].join('\n'),
  ],
  ['old.txt', 'gone one\ngone two\n'],
  ['lib/before.ts', 'const a = 1;\nconst b = 2;\n'],
  ['x/old name.ts', 'same\n'],
  ['tail.txt', 'last'],
]);
const head = new Map<string, string>([
  [
    'src/a.ts',
    [
      "import x from 'x';",
      '',
      'export function one() {',
      '  return 10;',
      '  // added',
      '}',
      '',
      'export function two() {',
      '  return 2;',
      '}',
      '',
      'export function three() {',
      '  return 30;',
      '}',
      '',
    ].join('\n'),
  ],
  ['docs/new.md', '# New\ntext\n'],
  ['lib/after.ts', 'const a = 1;\nconst b = 3;\n'],
  ['x/new name.ts', 'same\n'],
  ['café.txt', 'b\n'],
  ['tail.txt', 'last\n'],
]);
const read: SourceReader = (side, path) =>
  (side === 'RIGHT' ? head : mergeBase).get(path) ?? null;

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3,3 +3,4 @@ import x from 'x';
 export function one() {
-  return 1;
+  return 10;
+  // added
 }
@@ -11,3 +12,3 @@ export function two() {
 export function three() {
-  return 3;
+  return 30;
 }
diff --git a/docs/new.md b/docs/new.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1,2 @@
+# New
+text
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone one
-gone two
diff --git a/lib/before.ts b/lib/after.ts
similarity index 80%
rename from lib/before.ts
rename to lib/after.ts
index 5555555..6666666 100644
--- a/lib/before.ts
+++ b/lib/after.ts
@@ -1,2 +1,2 @@
 const a = 1;
-const b = 2;
+const b = 3;
diff --git a/x/old name.ts b/x/new name.ts
similarity index 100%
rename from x/old name.ts
rename to x/new name.ts
diff --git a/img/logo.png b/img/logo.png
index 7777777..8888888 100644
Binary files a/img/logo.png and b/img/logo.png differ
diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"
index 9999999..aaaaaaa 100644
--- "a/caf\\303\\251.txt"
+++ "b/caf\\303\\251.txt"
@@ -1 +1 @@
-a
+b
diff --git a/tail.txt b/tail.txt
index bbbbbbb..ccccccc 100644
--- a/tail.txt
+++ b/tail.txt
@@ -1 +1 @@
-last
\\ No newline at end of file
+last
`;

const diff = parseUnifiedDiff(DIFF);
const anchor = (
  path: string,
  side: 'RIGHT' | 'LEFT',
  line: number,
  end_line = line,
) => resolveAnchor(diff, { path, side, line, end_line }, read);
const failure = (result: ReturnType<typeof anchor>) =>
  result.ok ? 'ok' : result.reason;

describe('parseUnifiedDiff', () => {
  it('classifies added, deleted, renamed, binary and quoted-path files', () => {
    expect(
      diff.files.map(({ oldPath, newPath, status, binary }) => [
        oldPath,
        newPath,
        status,
        binary,
      ]),
    ).toEqual([
      ['src/a.ts', 'src/a.ts', 'modified', false],
      [null, 'docs/new.md', 'added', false],
      ['old.txt', null, 'deleted', false],
      ['lib/before.ts', 'lib/after.ts', 'renamed', false],
      ['x/old name.ts', 'x/new name.ts', 'renamed', false],
      ['img/logo.png', 'img/logo.png', 'modified', true],
      ['café.txt', 'café.txt', 'modified', false],
      ['tail.txt', 'tail.txt', 'modified', false],
    ]);
    expect(diff.truncated).toBe(false);
    expect(diff.files.every((file) => file.complete)).toBe(true);
  });

  it('numbers both sides of a multi-hunk file', () => {
    const second = diff.files[0]!.hunks[1]!;
    expect(
      second.lines.map((line) => [line.kind, line.oldLine, line.newLine]),
    ).toEqual([
      ['context', 11, 12],
      ['del', 12, null],
      ['add', null, 13],
      ['context', 13, 14],
    ]);
  });

  it('marks a hunk cut by truncation and the caller-flagged last file', () => {
    const cut = DIFF.slice(0, DIFF.indexOf('+  // added'));
    const parsed = parseUnifiedDiff(cut);
    expect(parsed.truncated).toBe(true);
    expect(parsed.files[0]!.complete).toBe(false);
    expect(
      failure(
        resolveAnchor(
          parsed,
          { path: 'src/a.ts', side: 'RIGHT', line: 4, end_line: 4 },
          read,
        ),
      ),
    ).toBe('anchor_truncated');

    const flagged = parseUnifiedDiff(DIFF, { truncated: true });
    expect(flagged.truncated).toBe(true);
    expect(flagged.files.at(-1)!.complete).toBe(false);
    expect(flagged.files[0]!.complete).toBe(true);
  });

  const cutHeader = 'diff --git a/f.ts b/f.ts\nindex 1111111..2222222 100644\n';
  it.each([
    ['before +++', `${cutHeader}--- a/f.ts\n`],
    ['before the first @@', `${cutHeader}--- a/f.ts\n+++ b/f.ts\n`],
    ['after the index line', cutHeader],
    ['right after diff --git', 'diff --git a/f.ts b/f.ts\n'],
    [
      'after the index line of a non-empty new file',
      'diff --git a/n.ts b/n.ts\nnew file mode 100644\nindex 0000000..3333333\n',
    ],
  ])('marks a diff cut %s as truncated, never complete', (_name, text) => {
    const parsed = parseUnifiedDiff(text);
    expect(parsed.truncated).toBe(true);
    expect(parsed.files[0]!.complete).toBe(false);
    expect(parsed.files[0]!.status).not.toBe('deleted');
  });

  it.each([
    [
      'a mode-only change',
      'diff --git a/m.sh b/m.sh\nold mode 100644\nnew mode 100755\n',
    ],
    [
      'an empty new file',
      'diff --git a/e.txt b/e.txt\nnew file mode 100644\nindex 0000000..e69de29\n',
    ],
    [
      'an empty deleted file',
      'diff --git a/e.txt b/e.txt\ndeleted file mode 100644\nindex e69de29..0000000\n',
    ],
    [
      'a binary change',
      'diff --git a/i.png b/i.png\nindex 1111111..2222222 100644\nBinary files a/i.png and b/i.png differ\n',
    ],
    [
      'a pure rename',
      'diff --git a/x.ts b/y.ts\nsimilarity index 100%\nrename from x.ts\nrename to y.ts\n',
    ],
  ])('keeps %s complete without hunks', (_name, text) => {
    const parsed = parseUnifiedDiff(text);
    expect(parsed.truncated).toBe(false);
    expect(parsed.files[0]!.complete).toBe(true);
  });

  it.each([
    ['content before a header', '@@ -1 +1 @@\n-a\n+b\n'],
    [
      'an unexpected hunk line',
      'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n*a\n',
    ],
    [
      'a traversal path',
      'diff --git a/../f b/../f\n--- a/../f\n+++ b/../f\n@@ -1 +1 @@\n-a\n+b\n',
    ],
    [
      'a missing a/ prefix',
      'diff --git f f\n--- f\n+++ f\n@@ -1 +1 @@\n-a\n+b\n',
    ],
    [
      'an unrecognized header line',
      'diff --git a/f b/f\nsurprise\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n',
    ],
    [
      'additions beyond the declared count',
      'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n+c\n',
    ],
  ])('fails closed on %s', (_name, text) => {
    expect(() => parseUnifiedDiff(text)).toThrow(
      expect.objectContaining({ code: 'E_INVALID_DIFF' }),
    );
  });
});

describe('resolveAnchor', () => {
  it('maps RIGHT single lines and ranges against the head tree', () => {
    expect(anchor('src/a.ts', 'RIGHT', 4)).toMatchObject({
      ok: true,
      position: { path: 'src/a.ts', side: 'RIGHT', line: 4, start_line: null },
      code: '  return 10;',
    });
    expect(anchor('src/a.ts', 'RIGHT', 3, 5)).toMatchObject({
      ok: true,
      position: { line: 5, start_line: 3 },
      code: 'export function one() {\n  return 10;\n  // added',
    });
    expect(anchor('src/a.ts', 'RIGHT', 13)).toMatchObject({
      ok: true,
      code: '  return 30;',
    });
  });

  it('maps LEFT lines against the merge-base tree', () => {
    expect(anchor('src/a.ts', 'LEFT', 12)).toMatchObject({
      ok: true,
      position: { path: 'src/a.ts', side: 'LEFT', line: 12 },
      code: '  return 3;',
    });
    // Old line 4 was deleted; new line 4 is a different, added line.
    expect(anchor('src/a.ts', 'LEFT', 4)).toMatchObject({
      ok: true,
      code: '  return 1;',
    });
  });

  it('handles renames on both sides', () => {
    expect(anchor('lib/after.ts', 'RIGHT', 2)).toMatchObject({
      ok: true,
      position: { path: 'lib/after.ts' },
      code: 'const b = 3;',
    });
    for (const cited of ['lib/before.ts', 'lib/after.ts'])
      expect(anchor(cited, 'LEFT', 2)).toMatchObject({
        ok: true,
        position: { path: 'lib/after.ts', side: 'LEFT' },
        sourcePath: 'lib/before.ts',
        code: 'const b = 2;',
      });
    expect(failure(anchor('lib/before.ts', 'RIGHT', 2))).toBe(
      'anchor_not_in_diff',
    );
    expect(failure(anchor('x/new name.ts', 'RIGHT', 1))).toBe(
      'anchor_outside_hunk',
    );
  });

  it('handles added, deleted, quoted and no-newline files', () => {
    expect(anchor('docs/new.md', 'RIGHT', 1, 2)).toMatchObject({ ok: true });
    expect(failure(anchor('docs/new.md', 'LEFT', 1))).toBe(
      'anchor_side_absent',
    );
    expect(anchor('old.txt', 'LEFT', 2)).toMatchObject({
      ok: true,
      position: { path: 'old.txt', side: 'LEFT' },
      code: 'gone two',
    });
    expect(failure(anchor('old.txt', 'RIGHT', 1))).toBe('anchor_not_in_diff');
    expect(anchor('café.txt', 'RIGHT', 1)).toMatchObject({
      ok: true,
      code: 'b',
    });
    expect(anchor('tail.txt', 'LEFT', 1)).toMatchObject({ ok: true });
    expect(anchor('tail.txt', 'RIGHT', 1)).toMatchObject({ ok: true });
  });

  it('rejects ranges outside or across hunks', () => {
    expect(failure(anchor('src/a.ts', 'RIGHT', 9))).toBe('anchor_outside_hunk');
    expect(failure(anchor('src/a.ts', 'RIGHT', 5, 8))).toBe(
      'anchor_outside_hunk',
    );
    expect(failure(anchor('src/a.ts', 'RIGHT', 4, 13))).toBe(
      'anchor_crosses_hunks',
    );
    expect(failure(anchor('src/other.ts', 'RIGHT', 1))).toBe(
      'anchor_not_in_diff',
    );
    expect(failure(anchor('img/logo.png', 'RIGHT', 1))).toBe('anchor_binary');
  });

  it('rejects anchors whose tree disagrees with the diff snapshot', () => {
    const stale: SourceReader = (side, path) =>
      side === 'RIGHT' && path === 'src/a.ts'
        ? head.get(path)!.replace('return 10', 'return 11')
        : read(side, path);
    expect(
      failure(
        resolveAnchor(
          diff,
          { path: 'src/a.ts', side: 'RIGHT', line: 4, end_line: 4 },
          stale,
        ),
      ),
    ).toBe('anchor_snapshot_mismatch');
    expect(
      failure(
        resolveAnchor(
          diff,
          { path: 'src/a.ts', side: 'RIGHT', line: 4, end_line: 4 },
          () => null,
        ),
      ),
    ).toBe('anchor_source_missing');
  });

  it('compares CRLF sources and diffs by line content', () => {
    const crlf = parseUnifiedDiff(
      'diff --git a/w.txt b/w.txt\r\n--- a/w.txt\r\n+++ b/w.txt\r\n@@ -1 +1 @@\r\n-x\r\n+y\r\n',
    );
    expect(
      resolveAnchor(
        crlf,
        { path: 'w.txt', side: 'RIGHT', line: 1, end_line: 1 },
        () => 'y\r\n',
      ),
    ).toMatchObject({ ok: true, code: 'y' });
  });
});

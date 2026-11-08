import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { proveConformanceGraph } from './graph.js';

const ENTRY = '.github/workflows/agent-ci-artifact-conformance.yml';
const NESTED = '.github/workflows/agent-ci-artifact-conformance-nested.yml';
const LEAF = '.github/workflows/agent-ci-artifact-conformance-leaf.yml';
const PATHS = [ENTRY, NESTED, LEAF];

function sources(): Record<string, string> {
  return Object.fromEntries(
    PATHS.map((path) => [path, readFileSync(path, 'utf8')]),
  );
}

function change(path: string, from: string, to: string) {
  const input = sources();
  const original = input[path];
  if (original === undefined || !original.includes(from)) {
    throw new Error('mutation did not reach its intended source');
  }
  input[path] = original.replace(from, to);
  return input;
}

const REFUSAL = { ok: false, code: 'E_CONFORMANCE_GRAPH' };

describe('complete synthetic conformance graph proof', () => {
  it('enumerates all eight unique assignments before any Jobs REST observation', () => {
    const result = proveConformanceGraph(sources());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('proof refused');
    expect(result.productionQualified).toBe(false);
    // Literal oracle from the reviewed workflow name grammar, independent of
    // the enumerator. Both repeated selectors and optional future jobs count.
    expect(
      result.assignments.map((assignment) => assignment.fullJobName),
    ).toEqual([
      'Matrix / scope-a / Nested / scope-a / producer / Capture / scope-a / producer',
      'Matrix / scope-a / Nested / scope-a / consumer / Capture / scope-a / consumer',
      'Matrix / scope-b / Nested / scope-b / producer / Capture / scope-b / producer',
      'Matrix / scope-b / Nested / scope-b / consumer / Capture / scope-b / consumer',
      'Repeated / scope-a / Nested / scope-a / producer / Capture / scope-a / producer',
      'Repeated / scope-a / Nested / scope-a / consumer / Capture / scope-a / consumer',
      'Optional / scope-b / Nested / scope-b / producer / Capture / scope-b / producer',
      'Optional / scope-b / Nested / scope-b / consumer / Capture / scope-b / consumer',
    ]);
    expect(
      result.assignments.map(({ invocationId, scope, role, optional }) => [
        invocationId,
        scope,
        role,
        optional,
      ]),
    ).toEqual([
      ['matrix:scope-a', 'scope-a', 'producer', false],
      ['matrix:scope-a', 'scope-a', 'consumer', false],
      ['matrix:scope-b', 'scope-b', 'producer', false],
      ['matrix:scope-b', 'scope-b', 'consumer', false],
      ['repeated:scope-a', 'scope-a', 'producer', false],
      ['repeated:scope-a', 'scope-a', 'consumer', false],
      ['optional:scope-b', 'scope-b', 'producer', true],
      ['optional:scope-b', 'scope-b', 'consumer', true],
    ]);
    expect(
      new Set(result.assignments.map((item) => item.fullJobName)).size,
    ).toBe(8);
    expect(
      new Set(
        result.assignments.map((item) =>
          JSON.stringify([item.invocationId, item.scope, item.role]),
        ),
      ).size,
    ).toBe(8);
    expect(result.assignments.filter((item) => !item.optional)).toHaveLength(6);
    expect(
      result.assignments.every((item) => item.leafWorkflowPath === LEAF),
    ).toBe(true);
  });

  it('binds the full source bytes while allowing equivalent YAML serialization', () => {
    const original = sources();
    const altered = {
      ...original,
      [ENTRY]: `${original[ENTRY]}\n# source byte change\n`,
    };
    const originalProof = proveConformanceGraph(original);
    const alteredProof = proveConformanceGraph(altered);
    expect(originalProof.ok && alteredProof.ok).toBe(true);
    if (!originalProof.ok || !alteredProof.ok) throw new Error('proof refused');
    expect(originalProof.workflowDigests).toEqual(
      PATHS.map((path) => ({
        path,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      })),
    );
    expect(alteredProof.assignments).toEqual(originalProof.assignments);
    expect(alteredProof.workflowDigests[0]?.sha256).not.toBe(
      originalProof.workflowDigests[0]?.sha256,
    );
    expect(
      proveConformanceGraph(
        Object.fromEntries(
          Object.entries(original).map(([path, source]) => [
            path,
            stringify(parse(source)),
          ]),
        ),
      ).ok,
    ).toBe(true);
  });

  it.each([
    [
      'duplicate matrix scope',
      ENTRY,
      'scope: [scope-a, scope-b]',
      'scope: [scope-a, scope-a]',
    ],
    [
      'duplicate matrix role',
      NESTED,
      'role: [producer, consumer]',
      'role: [producer, producer]',
    ],
    [
      'repeated invocation name alias',
      ENTRY,
      'name: Repeated / scope-a',
      'name: Matrix / scope-a',
    ],
    [
      'optional invocation name alias',
      ENTRY,
      'name: Optional / scope-b',
      'name: Matrix / scope-b',
    ],
    [
      'scope injection',
      ENTRY,
      'scope: [scope-a, scope-b]',
      "scope: ['scope-a / producer', scope-b]",
    ],
    [
      'role injection',
      NESTED,
      'role: [producer, consumer]',
      "role: ['producer / Capture', consumer]",
    ],
    [
      'dynamic matrix',
      NESTED,
      'role: [producer, consumer]',
      'role: ${{ fromJSON(inputs.roles) }}',
    ],
    [
      'matrix include expansion',
      ENTRY,
      'scope: [scope-a, scope-b]',
      'scope: [scope-a, scope-b]\n        include: [{ scope: scope-c }]',
    ],
    ['caller selector', ENTRY, 'scope: scope-a', 'scope: ${{ inputs.scope }}'],
    [
      'scope forwarding mutation',
      NESTED,
      'scope: ${{ inputs.scope }}',
      'scope: scope-b',
    ],
    [
      'role forwarding mutation',
      NESTED,
      'role: ${{ matrix.role }}',
      'role: consumer',
    ],
    [
      'leaf name mutation',
      LEAF,
      'name: Capture / ${{ inputs.scope }} / ${{ inputs.role }}',
      'name: Capture / ${{ inputs.scope }}',
    ],
    [
      'nested name mutation',
      NESTED,
      'name: Nested / ${{ inputs.scope }} / ${{ matrix.role }}',
      'name: Nested / ${{ inputs.scope }}',
    ],
    [
      'call path mutation',
      ENTRY,
      'uses: ./.github/workflows/agent-ci-artifact-conformance-nested.yml',
      'uses: ./.github/workflows/other.yml',
    ],
    [
      'reusable pin mutation',
      NESTED,
      'uses: ./.github/workflows/agent-ci-artifact-conformance-leaf.yml',
      'uses: tkstang/agent-ci/.github/workflows/agent-ci-artifact-conformance-leaf.yml@main',
    ],
    [
      'checkout pin mutation',
      LEAF,
      'ref: ${{ github.workflow_sha }}',
      'ref: main',
    ],
    [
      'checkout repository mutation',
      LEAF,
      'repository: tkstang/agent-ci',
      'repository: ${{ github.repository }}',
    ],
    [
      'optional guard mutation',
      ENTRY,
      'if: inputs.include_optional',
      'if: always()',
    ],
    [
      'leaf caller guard mutation',
      LEAF,
      "github.repository == 'tkstang/agent-ci'",
      "github.repository != 'tkstang/agent-ci'",
    ],
    ['permission elevation', LEAF, 'contents: read', 'contents: write'],
    [
      'environment authority',
      LEAF,
      '    runs-on: ubuntu-latest',
      '    environment: production\n    runs-on: ubuntu-latest',
    ],
    [
      'unknown executable step',
      LEAF,
      '    steps:',
      '    steps:\n      - run: echo unexpected',
    ],
    [
      'unknown late job',
      ENTRY,
      'jobs:',
      'jobs:\n  late:\n    runs-on: ubuntu-latest\n    steps: [{run: echo late}]',
    ],
    [
      'unknown workflow input',
      NESTED,
      '    inputs:',
      '    inputs:\n      extra:\n        type: string',
    ],
  ])(
    'refuses %s instead of trusting observed or claimed names',
    (_label, path, from, to) => {
      expect(proveConformanceGraph(change(path, from, to))).toEqual(REFUSAL);
    },
  );

  it('refuses missing and additional workflows', () => {
    for (const path of PATHS) {
      const input = sources();
      delete input[path];
      expect(proveConformanceGraph(input)).toEqual(REFUSAL);
    }
    expect(
      proveConformanceGraph({ ...sources(), 'unexpected.yml': 'jobs: {}' }),
    ).toEqual(REFUSAL);
  });

  it.each([
    [
      'duplicate key',
      'permissions:\n  contents: read\npermissions:\n  contents: read\n',
    ],
    ['alias', 'untrusted: &shared [one]\nalias: *shared\n'],
    ['explicit tag', 'name: !!str test\n'],
    ['custom tag', 'name: !unsafe test\n'],
    ['parse failure', 'jobs: [\n'],
    ['multiple documents', '---\nname: one\n---\nname: two\n'],
  ])('refuses hostile or unbounded YAML: %s', (_label, source) => {
    expect(proveConformanceGraph({ ...sources(), [ENTRY]: source })).toEqual(
      REFUSAL,
    );
  });

  it('bounds complete valid YAML by UTF-8 bytes rather than character count', () => {
    const input = sources();
    const source = input[ENTRY]!;
    const bounded = `${source}\n#${'x'.repeat(64 * 1024 - Buffer.byteLength(source) - 2)}`;
    expect(Buffer.byteLength(bounded)).toBe(64 * 1024);
    expect(proveConformanceGraph({ ...input, [ENTRY]: bounded }).ok).toBe(true);
    expect(proveConformanceGraph({ ...input, [ENTRY]: `${bounded}x` })).toEqual(
      REFUSAL,
    );
    const oversizedUtf8 = `${bounded.slice(0, -1)}é`;
    expect(oversizedUtf8.length).toBe(bounded.length);
    expect(proveConformanceGraph({ ...input, [ENTRY]: oversizedUtf8 })).toEqual(
      REFUSAL,
    );
  });

  it('refuses an explicit YAML tag on otherwise equivalent source', () => {
    const input = change(
      ENTRY,
      "name: 'CI: Artifact identity conformance'",
      "name: !!str 'CI: Artifact identity conformance'",
    );
    expect(parse(input[ENTRY]!)).toEqual(parse(sources()[ENTRY]!));
    expect(proveConformanceGraph(input)).toEqual(REFUSAL);
  });

  it('refuses aliases and duplicate keys even when expansion would equal the blueprint', () => {
    const original = sources();
    const permissions =
      'permissions:\n      contents: read\n      id-token: write';
    const anchored = change(
      ENTRY,
      permissions,
      'permissions: &permissions\n      contents: read\n      id-token: write',
    );
    // Anchors alone carry no expansion. An equivalent alias must still fail.
    expect(proveConformanceGraph(anchored).ok).toBe(true);
    const alias = {
      ...anchored,
      [ENTRY]: anchored[ENTRY]!.replace(
        permissions,
        'permissions: *permissions',
      ),
    };
    expect(parse(alias[ENTRY])).toEqual(parse(original[ENTRY]!));
    expect(proveConformanceGraph(alias)).toEqual(REFUSAL);
    expect(
      proveConformanceGraph(
        change(ENTRY, '  contents: read', '  contents: read\n  contents: read'),
      ),
    ).toEqual(REFUSAL);
  });
});

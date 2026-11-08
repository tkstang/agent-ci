import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { isAlias, isNode, parseDocument, visit } from 'yaml';

const ENTRY = '.github/workflows/agent-ci-artifact-conformance.yml';
const NESTED = '.github/workflows/agent-ci-artifact-conformance-nested.yml';
const LEAF = '.github/workflows/agent-ci-artifact-conformance-leaf.yml';
const PATHS = [ENTRY, NESTED, LEAF] as const;
const PERMISSIONS = { contents: 'read', 'id-token': 'write' };

// This reviewed blueprint is intentionally the entire synthetic grammar. New
// jobs, inputs, expressions, steps or authority require a new review, rather
// than extending a general GitHub expression/workflow interpreter.
const BLUEPRINT = {
  [ENTRY]: {
    name: 'CI: Artifact identity conformance',
    on: {
      workflow_dispatch: {
        inputs: {
          include_optional: {
            description: 'Include the optional synthetic invocation',
            type: 'boolean',
            default: false,
          },
        },
      },
    },
    permissions: { contents: 'read' },
    jobs: {
      matrix: {
        name: 'Matrix / ${{ matrix.scope }}',
        strategy: {
          'fail-fast': false,
          matrix: { scope: ['scope-a', 'scope-b'] },
        },
        permissions: PERMISSIONS,
        uses: `./${NESTED}`,
        with: { scope: '${{ matrix.scope }}' },
      },
      repeated: {
        name: 'Repeated / scope-a',
        permissions: PERMISSIONS,
        uses: `./${NESTED}`,
        with: { scope: 'scope-a' },
      },
      optional: {
        name: 'Optional / scope-b',
        if: 'inputs.include_optional',
        permissions: PERMISSIONS,
        uses: `./${NESTED}`,
        with: { scope: 'scope-b' },
      },
    },
  },
  [NESTED]: {
    name: 'CI: Nested artifact identity probe',
    on: {
      workflow_call: {
        inputs: { scope: { required: true, type: 'string' } },
      },
    },
    permissions: { contents: 'read' },
    jobs: {
      nested: {
        name: 'Nested / ${{ inputs.scope }} / ${{ matrix.role }}',
        permissions: PERMISSIONS,
        strategy: {
          'fail-fast': false,
          matrix: { role: ['producer', 'consumer'] },
        },
        uses: `./${LEAF}`,
        with: {
          scope: '${{ inputs.scope }}',
          role: '${{ matrix.role }}',
        },
      },
    },
  },
  [LEAF]: {
    name: 'CI: Artifact identity capture leaf',
    on: {
      workflow_call: {
        inputs: {
          scope: { required: true, type: 'string' },
          role: { required: true, type: 'string' },
        },
      },
    },
    permissions: { contents: 'read' },
    jobs: {
      capture: {
        name: 'Capture / ${{ inputs.scope }} / ${{ inputs.role }}',
        if: "github.repository == 'tkstang/agent-ci' && github.event_name == 'workflow_dispatch'",
        'runs-on': 'ubuntu-latest',
        'timeout-minutes': 5,
        permissions: PERMISSIONS,
        steps: [
          {
            name: 'Check out only the reviewed collector',
            uses: 'actions/checkout@v5',
            with: {
              repository: 'tkstang/agent-ci',
              ref: '${{ github.workflow_sha }}',
              'persist-credentials': false,
              'sparse-checkout':
                'package.json\nsrc/artifact-conformance/collect.ts\nsrc/artifact-conformance/verify.ts\n',
              'sparse-checkout-cone-mode': false,
            },
          },
          {
            name: 'Set up Node',
            uses: 'actions/setup-node@v6',
            with: { 'node-version': 24 },
          },
          {
            name: 'Capture allowlisted diagnostic claims',
            id: 'capture',
            env: {
              CONFORMANCE_SCOPE: '${{ inputs.scope }}',
              CONFORMANCE_ROLE: '${{ inputs.role }}',
            },
            run: 'node src/artifact-conformance/collect.ts',
          },
          {
            name: 'Upload only the diagnostic report',
            uses: 'actions/upload-artifact@v4',
            with: {
              name: '${{ steps.capture.outputs.artifact_name }}',
              path: '${{ steps.capture.outputs.report_path }}',
              'if-no-files-found': 'error',
              'retention-days': 1,
            },
          },
        ],
      },
    },
  },
};

export interface ConformanceAssignment {
  readonly invocationId: string;
  readonly scope: string;
  readonly role: string;
  readonly fullJobName: string;
  readonly optional: boolean;
  readonly leafWorkflowPath: string;
}

export type ConformanceGraphProof =
  | {
      readonly ok: true;
      readonly assignments: readonly ConformanceAssignment[];
      readonly workflowDigests: readonly {
        readonly path: string;
        readonly sha256: string;
      }[];
      readonly productionQualified: false;
    }
  | { readonly ok: false; readonly code: 'E_CONFORMANCE_GRAPH' };

function parseWorkflow(source: string): unknown {
  const document = parseDocument(source, {
    strict: true,
    uniqueKeys: true,
    version: '1.2',
  });
  if (document.errors.length !== 0 || document.warnings.length !== 0) {
    throw new Error('workflow refused');
  }
  visit(document, (_key, node) => {
    if (isAlias(node) || (isNode(node) && node.tag !== undefined)) {
      throw new Error('workflow refused');
    }
  });
  return document.toJS({ maxAliasCount: 0 });
}

/**
 * Preparation-only proof for this exact three-workflow synthetic packet.
 * Callers must obtain all three full source files from an independently pinned
 * revision; digests bind these bytes, but this function authenticates no source.
 * It consumes no Jobs REST listing and grants no access. The rendered name
 * grammar still needs independent live GitHub qualification.
 */
export function proveConformanceGraph(
  sources: Readonly<Record<string, string>>,
): ConformanceGraphProof {
  try {
    const keys = Object.keys(sources);
    if (
      keys.length !== PATHS.length ||
      keys.some((key) => !PATHS.some((path) => path === key))
    ) {
      throw new Error('workflow refused');
    }
    const workflowDigests = PATHS.map((path) => {
      const source = sources[path];
      if (
        typeof source !== 'string' ||
        Buffer.byteLength(source, 'utf8') > 64 * 1024 ||
        !isDeepStrictEqual(parseWorkflow(source), BLUEPRINT[path])
      ) {
        throw new Error('workflow refused');
      }
      return {
        path,
        sha256: createHash('sha256').update(source, 'utf8').digest('hex'),
      };
    });

    // The optional-on graph is the complete allowed graph. Optional-off can
    // only remove the two assignments marked optional, never introduce one.
    const entry = BLUEPRINT[ENTRY].jobs;
    const nested = BLUEPRINT[NESTED].jobs.nested;
    const leaf = BLUEPRINT[LEAF].jobs.capture;
    const invocations = [
      ...entry.matrix.strategy.matrix.scope.map((scope) => ({
        invocationId: `matrix:${scope}`,
        scope,
        name: entry.matrix.name.replace('${{ matrix.scope }}', scope),
        optional: false,
      })),
      {
        invocationId: 'repeated:scope-a',
        scope: entry.repeated.with.scope,
        name: entry.repeated.name,
        optional: false,
      },
      {
        invocationId: 'optional:scope-b',
        scope: entry.optional.with.scope,
        name: entry.optional.name,
        optional: true,
      },
    ];
    const assignments = invocations.flatMap((invocation) =>
      nested.strategy.matrix.role.map((role): ConformanceAssignment => {
        const nestedName = nested.name
          .replace('${{ inputs.scope }}', invocation.scope)
          .replace('${{ matrix.role }}', role);
        const leafName = leaf.name
          .replace('${{ inputs.scope }}', invocation.scope)
          .replace('${{ inputs.role }}', role);
        return {
          invocationId: invocation.invocationId,
          scope: invocation.scope,
          role,
          fullJobName: `${invocation.name} / ${nestedName} / ${leafName}`,
          optional: invocation.optional,
          leafWorkflowPath: LEAF,
        };
      }),
    );
    const identities = new Set<string>();
    const names = new Set<string>();
    for (const assignment of assignments) {
      const identity = JSON.stringify([
        assignment.invocationId,
        assignment.scope,
        assignment.role,
      ]);
      if (identities.has(identity) || names.has(assignment.fullJobName)) {
        throw new Error('workflow refused');
      }
      identities.add(identity);
      names.add(assignment.fullJobName);
    }
    return {
      ok: true,
      assignments,
      workflowDigests,
      productionQualified: false,
    };
  } catch {
    return { ok: false, code: 'E_CONFORMANCE_GRAPH' };
  }
}

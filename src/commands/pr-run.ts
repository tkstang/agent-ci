import { constants } from 'node:fs';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  optional,
  parseFlags,
  poolOptIn,
  positiveInt,
  required,
} from '@agent-ci/commands/flags.js';
import { appendGithubOutput } from '@agent-ci/commands/github.js';
import { runUrlFromEnv } from '@agent-ci/commands/publish.js';
import type { CommandContext, CommandSpec } from '@agent-ci/commands/types.js';
import { CliError } from '@agent-ci/errors.js';
import { DEFAULT_MODELS_PATH } from '@agent-ci/paths.js';
import { resolvePrRun } from '@agent-ci/pr-run/gate.js';
import { computePrMerge } from '@agent-ci/pr-run/merge.js';
import { buildPrRunTree, publishPrRun } from '@agent-ci/pr-run/publish.js';
import {
  parsePrRunRequest,
  type PrRunRequest,
} from '@agent-ci/pr-run/request.js';
import { digestResultDir, verifyResultDir } from '@agent-ci/publish/digest.js';
import { createGit } from '@agent-ci/publish/git.js';
import { readRunOutputs } from '@agent-ci/publish/publish.js';
import {
  fetchTransport,
  GithubClient,
  GithubError,
} from '@agent-ci/review/github.js';
import { runAgent } from '@agent-ci/run/execute.js';

const USAGE = `agent-ci pr-run <gate|execute|materialize|publish>

Run a newly created /agent-ci or @agent-ci PR comment against its exact head.
gate uses GITHUB_EVENT_PATH and GITHUB_ACTOR. --comment-id replays a real,
unedited comment by the dispatcher for a pre-merge workflow_dispatch test.
Tasks and review context travel in a digest-bound request artifact, never
shell source or job outputs. Skills use the selected harness's native syntax.

gate: --out <dir> [--comment-id <id>] [--allowed-pr-authors <lines>]
      --model <key> --allowed-models <lines> [--github-output]
execute: --request-dir <dir> --request-digest <hex> --cwd <checkout>
         --out <dir> --route <id> --home-root <dir> [--credential-from-env]
         [--timeout-minutes <n>] [--max-attempts <n>] [--allow-pool-value <bool>]
materialize/publish: --request-dir <dir> --request-digest <hex> --cwd <checkout>
                    --result-dir <dir> --result-digest <hex> [--github-output]
publish: [--verification <success|failure|skipped>]
GitHub credentials are used only by gate and publish.`;

const FLAGS = {
  out: { type: 'string' },
  cwd: { type: 'string' },
  'comment-id': { type: 'string' },
  'allowed-pr-authors': { type: 'string' },
  model: { type: 'string' },
  'allowed-models': { type: 'string' },
  'request-dir': { type: 'string' },
  'request-digest': { type: 'string' },
  'result-dir': { type: 'string' },
  'result-digest': { type: 'string' },
  route: { type: 'string' },
  'home-root': { type: 'string' },
  'timeout-minutes': { type: 'string' },
  'max-attempts': { type: 'string' },
  'allow-pool-value': { type: 'string' },
  'credential-from-env': { type: 'boolean' },
  'github-output': { type: 'boolean' },
  verification: { type: 'string' },
} as const;

function github(context: CommandContext): GithubClient {
  return new GithubClient(
    fetchTransport(
      required(
        context.env.GITHUB_TOKEN || context.env.GH_TOKEN,
        'GITHUB_TOKEN',
      ),
      context.env.GITHUB_API_URL,
    ),
  );
}

async function readRequest(dir: string, digest: string): Promise<PrRunRequest> {
  const verified = await verifyResultDir(dir, digest);
  if (!verified.ok) throw CliError.fromFailure(verified);
  const handle = await open(
    path.join(dir, 'request.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256 * 1024)
      throw new CliError('E_PR_RUN_REQUEST', 'invalid request artifact');
    const parsed = parsePrRunRequest(
      JSON.parse(await handle.readFile('utf8')) as unknown,
    );
    if (!parsed.ok) throw CliError.fromFailure(parsed);
    return parsed.value;
  } finally {
    await handle.close();
  }
}

export const prRunCommand: CommandSpec = {
  name: 'pr-run',
  summary: 'Execute a trusted PR comment and update its existing branch',
  usage: USAGE,
  async run(argv, context) {
    const [stage, ...rest] = argv;
    if (!['gate', 'execute', 'materialize', 'publish'].includes(stage ?? ''))
      throw new CliError('E_INVALID_INPUT', USAGE);
    const flags = parseFlags(rest, FLAGS, USAGE);
    const resolve = (value: string | undefined, flag: string) =>
      path.resolve(context.cwd, required(value, flag));
    if (stage === 'gate') {
      const model = required(flags.model, '--model');
      const allowed = required(flags['allowed-models'], '--allowed-models')
        .split(/[\s,]+/u)
        .filter(Boolean);
      if (!allowed.includes(model))
        throw new CliError(
          'E_PR_RUN_REQUEST',
          'the configured model is not allowed',
        );
      const eventFile = required(
        context.env.GITHUB_EVENT_PATH,
        'GITHUB_EVENT_PATH',
      );
      const client = github(context);
      const result = await resolvePrRun({
        github: client,
        repository: required(
          context.env.GITHUB_REPOSITORY,
          'GITHUB_REPOSITORY',
        ),
        actor: required(context.env.GITHUB_ACTOR, 'GITHUB_ACTOR'),
        eventName: required(context.env.GITHUB_EVENT_NAME, 'GITHUB_EVENT_NAME'),
        event: JSON.parse(await readFile(eventFile, 'utf8')) as unknown,
        ...(optional(flags['comment-id']) === undefined
          ? {}
          : { commentId: flags['comment-id'] }),
        allowedPrAuthors: (flags['allowed-pr-authors'] ?? '')
          .split(/[\s,]+/u)
          .filter(Boolean),
      });
      if (!result.ok) throw CliError.fromFailure(result);
      if (result.value.status === 'ignored') {
        if (flags['github-output'])
          await appendGithubOutput(context.env, { status: 'ignored' });
        return result.value;
      }
      const dir = resolve(flags.out, '--out');
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'request.json'),
        `${JSON.stringify(result.value.request)}\n`,
      );
      const digest = await digestResultDir(dir);
      if (!digest.ok) throw CliError.fromFailure(digest);
      const request = result.value.request;
      // Match PR review acknowledgement: a reaction failure must not drop
      // a request that already passed authorization and was persisted.
      try {
        await client.send(
          {
            method: 'POST',
            path: `/repos/${request.repository}/issues/comments/${request.commentId}/reactions`,
            body: { content: 'eyes' },
          },
          [200, 201],
        );
      } catch (error) {
        if (!(error instanceof GithubError)) throw error;
        context.log(
          'Could not add the eyes reaction; continuing the accepted PR task.',
        );
      }
      if (flags['github-output'])
        await appendGithubOutput(context.env, {
          status: 'ready',
          request_digest: digest.value,
          head_sha: request.headSha,
          head_ref: request.headRef,
          base_sha: request.baseSha,
          pr_number: String(request.prNumber),
          repository: request.repository,
        });
      return {
        status: 'ready',
        prNumber: request.prNumber,
        headSha: request.headSha,
      };
    }
    const request = await readRequest(
      resolve(flags['request-dir'], '--request-dir'),
      required(flags['request-digest'], '--request-digest'),
    );
    if (
      context.env.GITHUB_REPOSITORY &&
      request.repository !== context.env.GITHUB_REPOSITORY
    )
      throw new CliError(
        'E_PR_RUN_REQUEST',
        'request repository does not match this workflow',
      );
    const cwd = resolve(flags.cwd, '--cwd');
    const git = createGit(cwd, context.env);
    if (stage === 'execute') {
      const head = await git(['rev-parse', 'HEAD']);
      const dirty = await git(['diff', '--name-only', 'HEAD']);
      if (
        head.code !== 0 ||
        head.stdout.trim() !== request.headSha ||
        dirty.code !== 0 ||
        dirty.stdout.trim() !== ''
      )
        throw new CliError(
          'E_PR_RUN_REQUEST',
          'execution requires the clean pinned PR head',
        );
      const merge = await computePrMerge(git, request);
      if (!merge.ok) throw CliError.fromFailure(merge);
      if (merge.value.mergeParent !== null) {
        const prepared = await git([
          'read-tree',
          '--reset',
          '-u',
          merge.value.tree,
        ]);
        if (prepared.code !== 0)
          throw new CliError(
            'E_PR_RUN_FAILED',
            'could not prepare the conflict workspace',
          );
      }
      const summary = await runAgent({
        routeId: required(flags.route, '--route'),
        prompt: request.prompt,
        untrustedContext: request.context,
        cwd,
        outDir: resolve(flags.out, '--out'),
        mode: 'edit',
        outputContract: 'changes',
        useCase: 'pr-comment',
        targetRepo: request.repository,
        allowPool: poolOptIn(flags),
        seedLogin: false,
        homeRoot: resolve(flags['home-root'], '--home-root'),
        timeoutMs:
          positiveInt(flags['timeout-minutes'], '--timeout-minutes', 30) *
          60_000,
        maxAttempts: positiveInt(flags['max-attempts'], '--max-attempts', 2),
        retryDelayMs: 30_000,
        modelsPath: DEFAULT_MODELS_PATH,
        env: context.env,
        credentialFromEnv: flags['credential-from-env'] === true,
      });
      if (!summary.ok) throw CliError.fromFailure(summary);
      if (summary.value.error !== undefined)
        throw new CliError(
          summary.value.error.code,
          summary.value.error.message,
        );
      return { status: summary.value.result.status, headSha: request.headSha };
    }
    const outputs = await readRunOutputs(
      resolve(flags['result-dir'], '--result-dir'),
      {
        workspaceRoot: cwd,
        digest: required(flags['result-digest'], '--result-digest'),
      },
    );
    if (!outputs.ok) throw CliError.fromFailure(outputs);
    if (stage === 'materialize') {
      const tree = await buildPrRunTree(git, request, outputs.value);
      if (!tree.ok) throw CliError.fromFailure(tree);
      const restored = await git([
        'read-tree',
        '--reset',
        '-u',
        tree.value.tree,
      ]);
      if (restored.code !== 0)
        throw new CliError(
          'E_PR_RUN_FAILED',
          'could not materialize the final tree for verification',
        );
      return { status: 'ready', tree: tree.value.tree };
    }
    const verified = flags.verification === 'success';
    // Verification runs in a separate job that has neither model nor write credentials.
    const report = await publishPrRun({
      git,
      github: github(context),
      request,
      outputs: verified
        ? outputs.value
        : {
            ...outputs.value,
            result: {
              ...outputs.value.result,
              ok: false,
              status: 'failed',
              errors: [
                ...outputs.value.result.errors,
                'Final verification did not succeed; no commit was pushed.',
              ],
            },
          },
      runUrl: runUrlFromEnv(context.env),
    });
    if (!report.ok) throw CliError.fromFailure(report);
    if (flags['github-output'])
      await appendGithubOutput(context.env, {
        status: report.value.status,
        commit: report.value.commit ?? '',
        pr_url: report.value.prUrl,
        comment_url: report.value.commentUrl,
      });
    if (report.value.status === 'failed')
      throw new CliError(
        'E_PR_RUN_FAILED',
        'the PR task or final verification failed; see the PR summary',
      );
    return report.value;
  },
};

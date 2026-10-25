import path from 'node:path';

import { optional, parseFlags, required } from '@agent-ci/commands/flags.js';
import { appendGithubOutput } from '@agent-ci/commands/github.js';
import type { CommandContext, CommandSpec } from '@agent-ci/commands/types.js';
import { CliError } from '@agent-ci/errors.js';
import { createGit } from '@agent-ci/publish/git.js';
import { createGitHubClient } from '@agent-ci/publish/github.js';
import { publishRun, readRunOutputs } from '@agent-ci/publish/publish.js';
import {
  ACTIONS_BOT,
  DEFAULT_BRANCH_PREFIX,
} from '@agent-ci/publish/static-branch.js';
import { findWorkspaceRoot } from '@agent-ci/run/workspace.js';

const USAGE = `agent-ci publish — publish a finished run (separate job, write token).

Reads run-result.json and changes.json ONLY from --result-dir (the downloaded
run artifact), then:
  --pr | --publish-pr <true|false>
                             For an edit run that changed files: commit the
                             change set to a static branch (plumbing only, no
                             checkout, never a force push) and create or
                             update its pull request.
  --comment-on <number>      Create or update one marked comment on this pull
                             request (empty: skip).

Flags:
  --result-dir <dir>         Canonical result directory (required).
  --cwd <dir>                Git checkout of the target repository (default .).
  --repo <owner/name>        Default: $GITHUB_REPOSITORY.
  --branch <name>            Static branch (default <prefix><use-case>).
  --branch-prefix <prefix>   Agent-owned branch namespace (default agent-ci/);
                             --branch must live under it.
  --adopt-branch             Update a branch whose head agent-ci did not
                             publish (its history is kept, its content is
                             replaced). Without it such a branch is refused.
  --base <branch>            Pull request base branch (required with --pr).
  --title <text>             Pull request title.
  --comment-key <key>        Marker key for the comment (default: the branch).
  --run-url <url>            Default: built from GITHUB_SERVER_URL,
                             GITHUB_REPOSITORY and GITHUB_RUN_ID.
  --author-name / --author-email
                             Commit identity (default github-actions[bot]).
  --allow-workflow-changes   Allow .github/workflows changes (needs a token
                             with the workflow scope; GITHUB_TOKEN has none).
  --github-output            Write status, pr_url, pr_action, comment_url to
                             $GITHUB_OUTPUT.

The token comes from GITHUB_TOKEN (or GH_TOKEN) and is never printed.`;

export function runUrlFromEnv(env: CommandContext['env']): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  return GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : undefined;
}

function prNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (!/^[1-9]\d*$/u.test(value.trim())) {
    throw new CliError(
      'E_INVALID_INPUT',
      '--comment-on must be a pull request number',
    );
  }
  return Number(value.trim());
}

export function createPublishCommand(
  deps: { readonly fetch?: typeof fetch; readonly git?: string } = {},
): CommandSpec {
  return {
    name: 'publish',
    summary: 'Publish a run: static-branch pull request and PR comment',
    usage: USAGE,
    async run(argv, context) {
      const parsed = parseFlags(
        argv,
        {
          'result-dir': { type: 'string' },
          cwd: { type: 'string' },
          repo: { type: 'string' },
          pr: { type: 'boolean' },
          'publish-pr': { type: 'string' },
          branch: { type: 'string' },
          base: { type: 'string' },
          title: { type: 'string' },
          'comment-on': { type: 'string' },
          'comment-key': { type: 'string' },
          'run-url': { type: 'string' },
          'author-name': { type: 'string' },
          'author-email': { type: 'string' },
          'allow-workflow-changes': { type: 'boolean' },
          'branch-prefix': { type: 'string' },
          'adopt-branch': { type: 'boolean' },
          'github-output': { type: 'boolean' },
        },
        USAGE,
      );
      // Empty values (unset workflow inputs) behave like absent flags.
      const flags = {
        ...parsed,
        repo: optional(parsed.repo),
        branch: optional(parsed.branch),
        base: optional(parsed.base),
        title: optional(parsed.title),
        'comment-key': optional(parsed['comment-key']),
        'run-url': optional(parsed['run-url']),
        'branch-prefix': optional(parsed['branch-prefix']),
      };
      const publishPr = optional(parsed['publish-pr']);
      if (publishPr !== undefined && !['true', 'false'].includes(publishPr)) {
        throw new CliError(
          'E_INVALID_INPUT',
          '--publish-pr must be true or false',
        );
      }
      const cwd = path.resolve(context.cwd, flags.cwd ?? '.');
      const repo = required(
        flags.repo ?? context.env.GITHUB_REPOSITORY,
        '--repo (or GITHUB_REPOSITORY)',
      );
      const boundary = await findWorkspaceRoot(cwd, deps.git);
      const outputs = await readRunOutputs(
        path.resolve(
          context.cwd,
          required(flags['result-dir'], '--result-dir'),
        ),
        boundary.ok ? { workspaceRoot: boundary.value.root } : {},
      );
      if (!outputs.ok) throw CliError.fromFailure(outputs);
      const github = createGitHubClient({
        token: context.env.GITHUB_TOKEN || context.env.GH_TOKEN || '',
        repo,
        ...(context.env.GITHUB_API_URL
          ? { apiUrl: context.env.GITHUB_API_URL }
          : {}),
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      });
      if (!github.ok) throw CliError.fromFailure(github);
      const pullRequest = flags.pr === true || publishPr === 'true';
      const prefix = flags['branch-prefix'] ?? DEFAULT_BRANCH_PREFIX;
      const branch = flags.branch ?? `${prefix}${outputs.value.result.useCase}`;
      const report = await publishRun({
        outputs: outputs.value,
        github: github.value,
        ...(pullRequest
          ? { git: createGit(cwd, context.env, deps.git ?? 'git') }
          : {}),
        pullRequest,
        branch,
        baseBranch: pullRequest
          ? required(flags.base, '--base')
          : (flags.base ?? ''),
        ...(flags.title === undefined ? {} : { title: flags.title }),
        ...(prNumber(flags['comment-on']) === undefined
          ? {}
          : { commentOn: prNumber(flags['comment-on']) }),
        ...(flags['comment-key'] === undefined
          ? {}
          : { commentKey: flags['comment-key'] }),
        runUrl: flags['run-url'] ?? runUrlFromEnv(context.env),
        author: {
          name: flags['author-name'] ?? ACTIONS_BOT.name,
          email: flags['author-email'] ?? ACTIONS_BOT.email,
        },
        allowWorkflowChanges: flags['allow-workflow-changes'] === true,
        branchPrefix: prefix,
        adoptBranch: flags['adopt-branch'] === true,
      });
      if (!report.ok) throw CliError.fromFailure(report);
      const { pull, comment } = report.value;
      context.log(
        `agent-ci publish: status ${report.value.status}; pull request ${pull.action}${'url' in pull ? ` ${pull.url}` : ` (${pull.reason})`}; comment ${comment.action}${'url' in comment ? ` ${comment.url}` : ''}`,
      );
      if (flags['github-output'] === true) {
        await appendGithubOutput(context.env, {
          status: report.value.status,
          pr_action: pull.action,
          pr_url: 'url' in pull ? pull.url : '',
          comment_url: 'url' in comment ? comment.url : '',
        });
      }
      return { resultDir: outputs.value.dir, ...report.value };
    },
  };
}

export const publishCommand = createPublishCommand();

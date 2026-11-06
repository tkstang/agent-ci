import { realpathSync } from 'node:fs';
/**
 * Synthetic OIDC diagnostics only. Decoding a JWT is NOT signature verification
 * and this report confers no authority, grants or artifact-decryption access.
 * Keep this file stdlib-only so Node 24 can execute its TypeScript source.
 */
import { appendFile, mkdtemp, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const AUDIENCE = 'urn:agent-ci:artifact-conformance:v1';
const ISSUER = 'https://token.actions.githubusercontent.com';
const RESPONSE_LIMIT = 32 * 1024;
const TOKEN_LIMIT = 24 * 1024;
const DECIMAL = /^[1-9][0-9]{0,19}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const WORKFLOW_REF =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@[A-Za-z0-9_./-]{1,200}$/u;

type Environment = Readonly<Record<string, string | undefined>>;
type FailureCode = 'E_INVALID_INPUT' | 'E_GITHUB_API' | 'E_OUTPUT_PATH';
type PreflightReason =
  | 'request_url_missing'
  | 'request_url_too_long'
  | 'request_url_invalid'
  | 'request_protocol_refused'
  | 'request_host_refused'
  | 'request_userinfo_refused'
  | 'request_port_refused'
  | 'request_fragment_refused'
  | 'request_credential_missing'
  | 'request_credential_too_long'
  | 'request_credential_line_break'
  | 'runner_temp_invalid'
  | 'github_output_invalid'
  | 'preflight_exception';
type CaptureResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly reportPath: string;
        readonly artifactName: string;
      };
    }
  | {
      readonly ok: false;
      readonly code: 'E_INVALID_INPUT';
      readonly reason: PreflightReason;
    }
  | {
      readonly ok: false;
      readonly code: Exclude<FailureCode, 'E_INVALID_INPUT'>;
    };

function invalidInput(reason: PreflightReason): CaptureResult {
  return { ok: false, code: 'E_INVALID_INPUT', reason };
}

export interface ConformanceReport {
  readonly version: 1;
  readonly diagnostic_only: true;
  readonly signature_verified: false;
  readonly selectors_are_grants: false;
  readonly selector: {
    readonly scope: 'scope-a' | 'scope-b';
    readonly role: 'producer' | 'consumer';
  };
  readonly context: {
    readonly event_name: 'workflow_dispatch';
    readonly job_id: string;
  };
  readonly claims: {
    readonly iss: string;
    readonly aud: string;
    readonly run_id: string;
    readonly run_attempt: string;
    readonly check_run_id: string;
    readonly repository_id: string;
    readonly repository_owner_id: string;
    readonly workflow_ref: string;
    readonly workflow_sha: string;
    readonly job_workflow_ref: string;
    readonly job_workflow_sha: string;
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decimal(value: unknown): string | undefined {
  const text =
    typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : value;
  return typeof text === 'string' && DECIMAL.test(text) ? text : undefined;
}

function match(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

/** Allowlisted unverified diagnostics, never a general JWT authorization parser. */
export function inspectConformanceClaims(
  token: string,
  env: Environment,
): ConformanceReport | undefined {
  if (token.length > TOKEN_LIMIT) return undefined;
  const pieces = token.split('.');
  if (
    pieces.length !== 3 ||
    pieces.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))
  )
    return undefined;
  let payload: unknown;
  try {
    const encoded = pieces[1];
    if (encoded === undefined) return undefined;
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return undefined;
    payload = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  } catch {
    return undefined;
  }
  if (!object(payload) || payload.iss !== ISSUER || payload.aud !== AUDIENCE)
    return undefined;
  const runId = decimal(payload.run_id);
  const attempt = decimal(payload.run_attempt);
  const checkRunId = decimal(payload.check_run_id);
  const repositoryId = decimal(payload.repository_id);
  const ownerId = decimal(payload.repository_owner_id);
  const scope = env.CONFORMANCE_SCOPE;
  const role = env.CONFORMANCE_ROLE;
  const jobId = env.GITHUB_JOB;
  if (
    runId === undefined ||
    attempt === undefined ||
    checkRunId === undefined ||
    repositoryId === undefined ||
    ownerId === undefined ||
    runId !== env.GITHUB_RUN_ID ||
    attempt !== env.GITHUB_RUN_ATTEMPT ||
    repositoryId !== env.GITHUB_REPOSITORY_ID ||
    ownerId !== env.GITHUB_REPOSITORY_OWNER_ID ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== 'tkstang/agent-ci' ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    (scope !== 'scope-a' && scope !== 'scope-b') ||
    (role !== 'producer' && role !== 'consumer') ||
    !match(jobId, /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u) ||
    !match(payload.workflow_ref, WORKFLOW_REF) ||
    !match(payload.job_workflow_ref, WORKFLOW_REF) ||
    !match(payload.workflow_sha, SHA) ||
    !match(payload.job_workflow_sha, SHA) ||
    payload.workflow_ref !== env.GITHUB_WORKFLOW_REF ||
    payload.workflow_sha !== env.GITHUB_WORKFLOW_SHA
  )
    return undefined;
  return {
    version: 1,
    diagnostic_only: true,
    signature_verified: false,
    selectors_are_grants: false,
    selector: { scope, role },
    context: { event_name: 'workflow_dispatch', job_id: jobId },
    claims: {
      iss: ISSUER,
      aud: AUDIENCE,
      run_id: runId,
      run_attempt: attempt,
      check_run_id: checkRunId,
      repository_id: repositoryId,
      repository_owner_id: ownerId,
      workflow_ref: payload.workflow_ref,
      workflow_sha: payload.workflow_sha,
      job_workflow_ref: payload.job_workflow_ref,
      job_workflow_sha: payload.job_workflow_sha,
    },
  };
}

async function readResponse(response: Response): Promise<string | undefined> {
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > RESPONSE_LIMIT) return undefined;
      chunks.push(next.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Capture only validated diagnostic fields into fresh private staging. The
 * injected transport is the external HTTP boundary, not a testing mode.
 */
export async function collectConformanceReport(
  env: Environment,
  request: typeof fetch = fetch,
): Promise<CaptureResult> {
  let stage: string | undefined;
  let code: FailureCode = 'E_INVALID_INPUT';
  try {
    const rawUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const credential = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    const temp = env.RUNNER_TEMP;
    const output = env.GITHUB_OUTPUT;
    if (rawUrl === undefined) return invalidInput('request_url_missing');
    if (rawUrl.length > 4096) return invalidInput('request_url_too_long');
    if (credential === undefined || credential.length === 0)
      return invalidInput('request_credential_missing');
    if (credential.length > 4096)
      return invalidInput('request_credential_too_long');
    if (/[\r\n]/u.test(credential))
      return invalidInput('request_credential_line_break');
    if (temp === undefined || !path.isAbsolute(temp))
      return invalidInput('runner_temp_invalid');
    if (output === undefined || !path.isAbsolute(output))
      return invalidInput('github_output_invalid');
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return invalidInput('request_url_invalid');
    }
    if (url.protocol !== 'https:')
      return invalidInput('request_protocol_refused');
    if (!url.hostname.endsWith('.actions.githubusercontent.com'))
      return invalidInput('request_host_refused');
    if (url.username !== '' || url.password !== '')
      return invalidInput('request_userinfo_refused');
    if (url.port !== '' && url.port !== '443')
      return invalidInput('request_port_refused');
    if (url.hash !== '') return invalidInput('request_fragment_refused');
    url.searchParams.set('audience', AUDIENCE);
    code = 'E_GITHUB_API';
    const response = await request(url, {
      headers: { Authorization: `Bearer ${credential}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) return { ok: false, code };
    const body = await readResponse(response);
    if (body === undefined) return { ok: false, code };
    const parsed: unknown = JSON.parse(body);
    if (!object(parsed) || typeof parsed.value !== 'string')
      return { ok: false, code };
    const report = inspectConformanceClaims(parsed.value, env);
    if (report === undefined) return { ok: false, code };
    code = 'E_OUTPUT_PATH';
    stage = await mkdtemp(path.join(temp, 'agent-ci-oidc-'));
    const reportPath = path.join(stage, 'report.json');
    const file = await open(reportPath, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    } finally {
      await file.close();
    }
    const artifactName = `oidc-${report.selector.scope}-${report.selector.role}-${report.claims.run_attempt}-${report.claims.check_run_id}`;
    await appendFile(
      output,
      `report_path=${reportPath}\nartifact_name=${artifactName}\n`,
    );
    return { ok: true, value: { reportPath, artifactName } };
  } catch {
    if (stage !== undefined)
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    return code === 'E_INVALID_INPUT'
      ? invalidInput('preflight_exception')
      : { ok: false, code };
  }
}

function directlyExecuted(): boolean {
  try {
    return (
      process.argv[1] !== undefined &&
      import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
}

if (directlyExecuted()) {
  const result = await collectConformanceReport(process.env);
  // No exception text, token, request URL, arbitrary claims or environment.
  process.stdout.write(
    `${JSON.stringify(result.ok ? { ok: true } : result)}\n`,
  );
  process.exitCode = result.ok ? 0 : 1;
}

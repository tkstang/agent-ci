import { createHash } from 'node:crypto';

import {
  CHECK_EVIDENCE_ID,
  CHECK_NAME,
  closedRecord,
  contractError,
  isHex64,
  isRepository,
  isSha,
  sha256,
} from '@agent-ci/review/contracts.js';
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * verify-review's repository checks and their evidence.
 *
 * The checks are a fixed allowlist of named commands in
 * `.github/agent-ci/checks.yaml`, read from the head of the repository's
 * DEFAULT branch (or a branch the trusted workflow names with
 * `verify_config_ref`), never from the PR or the PR's base, which a
 * write-access author can retarget to a branch they pushed. A pull request
 * can therefore neither add a check nor redefine one (its code still runs
 * inside them: that is what a check is). The reviewer can only
 * pick a name; it never supplies a command or an argument.
 *
 * The verify stage runs every configured check once, where no model
 * credential exists, and records each result in `checks.json`. Each entry's
 * evidence id is a hash over the check name, the command, the head SHA, the
 * exit code and the output digest, so the findings gate can recompute it and
 * refuse an entry that was altered or a citation that names no entry.
 * Evidence is an observation attributable to the PR head, not an
 * attestation: PR code ran in the same environment that recorded it.
 */

/** Where the checks configuration lives in a repository. */
export const CHECKS_CONFIG_PATH = '.github/agent-ci/checks.yaml';

export const CHECK_LIMITS = Object.freeze({
  checks: 10,
  configBytes: 64 * 1024,
  commandBytes: 2048,
  descriptionChars: 200,
  defaultTimeoutMinutes: 10,
  maxTimeoutMinutes: 30,
  /** Output bytes captured (and digested) per command. */
  outputBytes: 1024 * 1024,
  /** Tail of the captured output kept in the evidence file. */
  tailBytes: 16 * 1024,
});

/** `check-` and 24 lowercase hex characters (96 bits of the hash). */
export const EVIDENCE_ID = CHECK_EVIDENCE_ID;

const Command = z
  .string()
  .refine(
    (value) =>
      value.trim() !== '' &&
      !value.includes('\0') &&
      Buffer.byteLength(value, 'utf8') <= CHECK_LIMITS.commandBytes,
    `must be a non-empty command of at most ${CHECK_LIMITS.commandBytes} bytes`,
  );
const Timeout = z
  .number()
  .int()
  .min(1)
  .max(CHECK_LIMITS.maxTimeoutMinutes)
  .default(CHECK_LIMITS.defaultTimeoutMinutes);

const ChecksConfigSchema = z.strictObject({
  version: z.literal(1),
  setup: z
    .strictObject({ command: Command, timeout_minutes: Timeout })
    .optional(),
  checks: z
    .array(
      z.strictObject({
        name: z.string().regex(CHECK_NAME, 'must match [a-z][a-z0-9-]{0,39}'),
        command: Command,
        description: z
          .string()
          .max(CHECK_LIMITS.descriptionChars)
          .refine(
            (value) => !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value),
            'must be one line of plain text',
          )
          .default(''),
        timeout_minutes: Timeout,
      }),
    )
    .min(1)
    .max(CHECK_LIMITS.checks),
});

export type CheckDefinition = {
  name: string;
  command: string;
  description: string;
  timeout_minutes: number;
};
export type ChecksConfig = {
  version: 1;
  setup: { command: string; timeout_minutes: number } | null;
  checks: CheckDefinition[];
};

/** The checks configuration as bound into the review spec. */
export type VerifySpec = {
  config_path: string;
  /** The branch the configuration was read from (default branch or named). */
  config_ref: string;
  /** That branch's head commit when it was read. */
  config_commit: string;
  /** sha256 of the configuration file bytes. */
  config_sha256: string;
  config: ChecksConfig;
};

/** A plausible branch name for the record (git's rules are checked when read). */
const CONFIG_REF = /^[^\p{Cc}\s~^:?*[\\]{1,255}$/u;

function configError(message: string): never {
  return contractError('E_VERIFY_CONFIG', message);
}

/** Parse and validate `checks.yaml` text. Throws `E_VERIFY_CONFIG`. */
export function parseChecksConfig(text: string): ChecksConfig {
  if (Buffer.byteLength(text, 'utf8') > CHECK_LIMITS.configBytes)
    configError(
      `${CHECKS_CONFIG_PATH} is larger than ${CHECK_LIMITS.configBytes} bytes`,
    );
  let raw: unknown;
  try {
    raw = parse(text, { maxAliasCount: 0 });
  } catch {
    return configError(`${CHECKS_CONFIG_PATH} is not valid YAML`);
  }
  const parsed = ChecksConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return configError(
      `${CHECKS_CONFIG_PATH}: ${issue?.path.join('.') || 'root'} ${issue?.message ?? 'is invalid'}`,
    );
  }
  const names = parsed.data.checks.map((check) => check.name);
  if (new Set(names).size !== names.length)
    configError(`${CHECKS_CONFIG_PATH}: check names must be unique`);
  return {
    version: 1,
    setup: parsed.data.setup ?? null,
    checks: parsed.data.checks,
  };
}

/** Build the spec's verify section from the file text and where it came from. */
export function verifySpecFromText(
  text: string,
  source: { ref: string; commit: string },
): VerifySpec {
  return {
    config_path: CHECKS_CONFIG_PATH,
    config_ref: source.ref,
    config_commit: source.commit,
    config_sha256: sha256(text),
    config: parseChecksConfig(text),
  };
}

/** Re-validate a verify section read back from a spec file. */
export function validateVerifySpec(value: unknown): VerifySpec {
  if (
    !closedRecord(value, [
      'config_path',
      'config_ref',
      'config_commit',
      'config_sha256',
      'config',
    ]) ||
    value.config_path !== CHECKS_CONFIG_PATH ||
    typeof value.config_ref !== 'string' ||
    !CONFIG_REF.test(value.config_ref) ||
    !isSha(value.config_commit) ||
    !isHex64(value.config_sha256)
  )
    return contractError(
      'E_REVIEW_INPUT',
      'the spec verify section is invalid',
    );
  let config: ChecksConfig;
  try {
    // The same schema as the file: a spec cannot carry a looser config.
    const raw = value.config;
    const parsed = ChecksConfigSchema.safeParse(
      closedRecord(raw, ['version', 'setup', 'checks']) && raw.setup === null
        ? { version: raw.version, checks: raw.checks }
        : raw,
    );
    if (!parsed.success) throw new Error('invalid');
    config = {
      version: 1,
      setup: parsed.data.setup ?? null,
      checks: parsed.data.checks,
    };
  } catch {
    return contractError(
      'E_REVIEW_INPUT',
      'the spec verify section is invalid',
    );
  }
  if (
    JSON.stringify(config) !== JSON.stringify(value.config) ||
    new Set(config.checks.map((c) => c.name)).size !== config.checks.length
  )
    contractError('E_REVIEW_INPUT', 'the spec verify section is invalid');
  return {
    config_path: CHECKS_CONFIG_PATH,
    config_ref: value.config_ref,
    config_commit: value.config_commit,
    config_sha256: value.config_sha256,
    config,
  };
}

/**
 * How a command was contained, recorded per entry: `linux-namespaces` (user
 * and pid namespaces, plus a loopback-only network namespace for checks),
 * `macos-sandbox` (`sandbox-exec`: confined writes, denied reads of agent-ci
 * directories and credential stores, no network for checks), or `none`
 * (the network was reachable). Setup always keeps the network.
 */
export const ISOLATIONS = [
  'linux-namespaces',
  'macos-sandbox',
  'none',
] as const;
export type Isolation = (typeof ISOLATIONS)[number];

/** One recorded command (a check or the setup command). */
export type CommandRecord = {
  command: string;
  /** `null` when the command was killed (timeout or signal). */
  exit_code: number | null;
  timed_out: boolean;
  /** True when the output capture was cut at `outputBytes`. */
  truncated: boolean;
  output_sha256: string;
  /** At most `tailBytes` of UTF-8: the end of the decoded, masked output. */
  output_tail: string;
  duration_ms: number;
  isolation: Isolation;
};
export type CheckEntry = CommandRecord & {
  evidence_id: string;
  name: string;
};
/** `checks.json`: one verify run, bound to its repository, head and config. */
export type ChecksEvidence = {
  version: 1;
  repository: string;
  head_sha: string;
  config_sha256: string;
  /** `setup-failed`: setup did not exit 0, so no check ran. */
  status: 'complete' | 'setup-failed';
  setup: CommandRecord | null;
  entries: CheckEntry[];
};

/** The evidence id of one recorded check (see the module comment). */
export function checkEvidenceId(input: {
  name: string;
  command: string;
  head_sha: string;
  exit_code: number | null;
  output_sha256: string;
}): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'agent-ci-check-evidence-v1',
        input.name,
        input.command,
        input.head_sha,
        input.exit_code,
        input.output_sha256,
      ]),
    )
    .digest('hex');
  return `check-${digest.slice(0, 24)}`;
}

function evidenceError(message: string): never {
  return contractError('E_VERIFY_EVIDENCE', message);
}

const RECORD_FIELDS = [
  'command',
  'exit_code',
  'timed_out',
  'truncated',
  'output_sha256',
  'output_tail',
  'duration_ms',
  'isolation',
] as const;

function commandRecord(value: unknown, at: string): CommandRecord {
  if (
    !closedRecord(value, RECORD_FIELDS) ||
    typeof value.command !== 'string' ||
    !(value.exit_code === null || Number.isSafeInteger(value.exit_code)) ||
    typeof value.timed_out !== 'boolean' ||
    typeof value.truncated !== 'boolean' ||
    !isHex64(value.output_sha256) ||
    typeof value.output_tail !== 'string' ||
    Buffer.byteLength(value.output_tail, 'utf8') > CHECK_LIMITS.tailBytes ||
    !Number.isSafeInteger(value.duration_ms) ||
    (value.duration_ms as number) < 0 ||
    !(ISOLATIONS as readonly unknown[]).includes(value.isolation)
  )
    evidenceError(`${at} is not a valid command record`);
  return {
    command: value.command,
    exit_code: value.exit_code as number | null,
    timed_out: value.timed_out,
    truncated: value.truncated,
    output_sha256: value.output_sha256,
    output_tail: value.output_tail,
    duration_ms: value.duration_ms as number,
    isolation: value.isolation as Isolation,
  };
}

/**
 * Validate an untrusted `checks.json` against the trusted spec: the same
 * repository, head and config digest; when setup succeeded, exactly the
 * configured checks in order with their configured commands; and every
 * evidence id recomputed. Throws `E_VERIFY_EVIDENCE`.
 */
export function validateChecksEvidence(
  value: unknown,
  expected: { repository: string; head_sha: string; verify: VerifySpec },
): ChecksEvidence {
  if (
    !closedRecord(value, [
      'version',
      'repository',
      'head_sha',
      'config_sha256',
      'status',
      'setup',
      'entries',
    ]) ||
    value.version !== 1 ||
    !isRepository(value.repository) ||
    !isSha(value.head_sha) ||
    !isHex64(value.config_sha256) ||
    (value.status !== 'complete' && value.status !== 'setup-failed') ||
    !Array.isArray(value.entries)
  )
    evidenceError('checks.json is not a valid evidence file');
  if (
    value.repository !== expected.repository ||
    value.head_sha !== expected.head_sha ||
    value.config_sha256 !== expected.verify.config_sha256
  )
    evidenceError('checks.json is bound to another repository, head or config');
  const config = expected.verify.config;
  const setup =
    value.setup === null ? null : commandRecord(value.setup, 'setup');
  if ((setup === null) !== (config.setup === null))
    evidenceError('checks.json setup does not match the config');
  if (setup !== null && setup.command !== config.setup?.command)
    evidenceError('checks.json setup command does not match the config');
  const setupFailed = setup !== null && setup.exit_code !== 0;
  if ((value.status === 'setup-failed') !== setupFailed)
    evidenceError('checks.json status does not match its setup record');
  const entries = value.entries.map((raw, index): CheckEntry => {
    if (!closedRecord(raw, ['evidence_id', 'name', ...RECORD_FIELDS]))
      evidenceError(`entry ${index} is not a valid check entry`);
    const { evidence_id: evidenceId, name, ...rest } = raw;
    const record = commandRecord(rest, `entry ${index}`);
    if (typeof name !== 'string' || typeof evidenceId !== 'string')
      evidenceError(`entry ${index} is not a valid check entry`);
    if (
      !EVIDENCE_ID.test(evidenceId) ||
      evidenceId !==
        checkEvidenceId({
          name,
          command: record.command,
          head_sha: expected.head_sha,
          exit_code: record.exit_code,
          output_sha256: record.output_sha256,
        })
    )
      evidenceError(`entry ${index} evidence id does not match its record`);
    return { evidence_id: evidenceId, name, ...record };
  });
  const want = setupFailed ? [] : config.checks;
  if (
    entries.length !== want.length ||
    entries.some(
      (entry, index) =>
        entry.name !== want[index]?.name ||
        entry.command !== want[index]?.command,
    )
  )
    evidenceError('checks.json entries do not match the configured checks');
  return {
    version: 1,
    repository: value.repository,
    head_sha: value.head_sha,
    config_sha256: value.config_sha256,
    status: value.status,
    setup,
    entries,
  };
}

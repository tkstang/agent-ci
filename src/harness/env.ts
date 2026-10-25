import { KNOWN_CREDENTIAL_ENV } from '@agent-ci/contracts/secret-guard.js';
import type { Route } from '@agent-ci/routing/schema.js';

/**
 * Non-credential variables a harness child may inherit. Everything else in
 * the parent environment is dropped: no inherited credential, config home or
 * provider override reaches the child unless the route names it.
 */
export const BASE_ENV_ALLOWLIST = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'NO_COLOR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const;

export interface ChildEnvInput {
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  readonly route: Pick<Route, 'credentials'>;
  /** Isolated home variables (HOME, XDG_*, CLAUDE_CONFIG_DIR, CODEX_HOME). */
  readonly homeEnv: Readonly<Record<string, string>>;
  /** Static, non-secret adapter settings (for example ANTHROPIC_BASE_URL). */
  readonly settings?: Readonly<Record<string, string>>;
}

export class CredentialLeakError extends Error {
  override readonly name = 'CredentialLeakError';
}

/**
 * Build a child environment from the allowlist. Credential variables come
 * only from the route's `credentials` list; adapter settings may not smuggle
 * in a known credential variable.
 */
export function buildChildEnv(input: ChildEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of BASE_ENV_ALLOWLIST) {
    const value = input.parentEnv[name];
    if (value !== undefined) env[name] = value;
  }
  for (const name of input.route.credentials) {
    const value = input.parentEnv[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  const known: readonly string[] = KNOWN_CREDENTIAL_ENV;
  for (const [name, value] of Object.entries(input.settings ?? {})) {
    if (known.includes(name) && !input.route.credentials.includes(name)) {
      throw new CredentialLeakError(
        `adapter setting ${name} is a credential the route does not name`,
      );
    }
    env[name] = value;
  }
  Object.assign(env, input.homeEnv);
  return env;
}

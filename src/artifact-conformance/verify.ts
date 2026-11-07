import { constants, createPublicKey, verify } from 'node:crypto';

export type TokenVerificationResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'invalid_token'
        | 'invalid_header'
        | 'jwks_unavailable'
        | 'invalid_jwks'
        | 'invalid_signature'
        | 'invalid_claims';
    };

const ISSUER = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'urn:agent-ci:artifact-conformance:v1';
// Pinned from the issuer's public OpenID discovery document; never token-directed.
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 24 * 1024;
const CLOCK_SKEW_SECONDS = 60;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decode(value: string, maximum: number): Buffer | undefined {
  if (
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length > Math.ceil((maximum * 4) / 3)
  ) {
    return undefined;
  }
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length <= maximum && bytes.toString('base64url') === value
    ? bytes
    : undefined;
}

/** JSON.parse validates grammar; this small lexical pass rejects duplicate object keys,
 * including escaped aliases, before any header, claim, or key is trusted. */
function parseRecord(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (!record(parsed)) return undefined;
    const stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (character === '"') {
        const start = index++;
        for (; index < text.length; index++) {
          if (text[index] === '\\') index++;
          else if (text[index] === '"') break;
        }
        const container = stack.at(-1);
        if (container?.key) {
          const key: string = JSON.parse(text.slice(start, index + 1));
          if (container.keys.has(key)) return undefined;
          container.keys.add(key);
          container.key = false;
        }
      } else if (character === '{') {
        stack.push({ keys: new Set(), key: true });
      } else if (character === '[') stack.push(null);
      else if (character === '}' || character === ']') stack.pop();
      else if (character === ',') {
        const container = stack.at(-1);
        if (container) container.key = true;
      }
      if (stack.length > 32) return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

async function fetchKeys(
  request: typeof fetch,
): Promise<Record<string, unknown> | undefined> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await request(JWKS_URL, {
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: { accept: 'application/json' },
        });
        if (
          controller.signal.aborted ||
          response.status !== 200 ||
          response.redirected ||
          (response.url !== '' && response.url !== JWKS_URL) ||
          !response.body
        )
          return undefined;
        const length = response.headers.get('content-length');
        if (
          length !== null &&
          (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)
        ) {
          return undefined;
        }
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const chunk = await reader.read();
          if (controller.signal.aborted) return undefined;
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_BODY_BYTES) return undefined;
          chunks.push(chunk.value);
        }
        return parseRecord(Buffer.concat(chunks));
      })(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, 10_000);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Cancellation must not extend the deadline even for an uncooperative transport.
    void reader?.cancel().catch(() => undefined);
  }
}

function publicRsaKey(value: Record<string, unknown>) {
  if (
    value.kty !== 'RSA' ||
    value.use !== 'sig' ||
    value.alg !== 'RS256' ||
    ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some((key) =>
      Object.hasOwn(value, key),
    ) ||
    (value.key_ops !== undefined &&
      (!Array.isArray(value.key_ops) ||
        value.key_ops.length !== 1 ||
        value.key_ops[0] !== 'verify')) ||
    typeof value.n !== 'string' ||
    typeof value.e !== 'string'
  )
    return undefined;
  const modulus = decode(value.n, 512);
  const exponent = decode(value.e, 4);
  if (
    !modulus?.length ||
    modulus[0] === 0 ||
    !exponent?.length ||
    exponent[0] === 0
  ) {
    return undefined;
  }
  const bits = (modulus.length - 1) * 8 + (32 - Math.clz32(modulus[0]!));
  let exponentValue = 0;
  for (const byte of exponent) exponentValue = exponentValue * 256 + byte;
  if (
    bits < 2048 ||
    bits > 4096 ||
    exponentValue < 3 ||
    exponentValue % 2 === 0
  )
    return undefined;
  try {
    return createPublicKey({
      key: { kty: 'RSA', n: value.n, e: value.e },
      format: 'jwk',
    });
  } catch {
    return undefined;
  }
}

/** Authenticates this synthetic probe only. The caller supplies an independently
 * expected subject and separately validates immutable repository/run/source claims.
 * No token, claim, key, transport error, or cryptographic error is returned. */
export async function verifyConformanceToken(
  token: string,
  expectedSubject: string,
  request: typeof fetch = fetch,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<TokenVerificationResult> {
  if (typeof token !== 'string' || Buffer.byteLength(token) > MAX_TOKEN_BYTES) {
    return { ok: false, reason: 'invalid_token' };
  }
  const segments = token.split('.');
  if (segments.length !== 3) return { ok: false, reason: 'invalid_token' };
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const headerBytes = decode(encodedHeader!, 4096);
  const payloadBytes = decode(encodedPayload!, MAX_TOKEN_BYTES);
  const signature = decode(encodedSignature!, 512);
  if (!headerBytes || !payloadBytes || !signature || signature.length < 256) {
    return { ok: false, reason: 'invalid_token' };
  }
  const header = parseRecord(headerBytes);
  const claims = parseRecord(payloadBytes);
  if (!header || !claims) return { ok: false, reason: 'invalid_token' };
  if (
    header.alg !== 'RS256' ||
    typeof header.kid !== 'string' ||
    !/^[\x21-\x7e]{1,256}$/.test(header.kid) ||
    ['jwk', 'jku', 'x5u', 'x5c', 'crit', 'b64'].some((key) =>
      Object.hasOwn(header, key),
    ) ||
    (header.typ !== undefined && header.typ !== 'JWT')
  )
    return { ok: false, reason: 'invalid_header' };

  const jwks = await fetchKeys(request);
  if (!jwks) return { ok: false, reason: 'jwks_unavailable' };
  if (
    !Array.isArray(jwks.keys) ||
    jwks.keys.length === 0 ||
    jwks.keys.length > 16
  ) {
    return { ok: false, reason: 'invalid_jwks' };
  }
  const matches = jwks.keys.filter(
    (key: unknown) => record(key) && key.kid === header.kid,
  );
  if (matches.length !== 1 || !record(matches[0]))
    return { ok: false, reason: 'invalid_jwks' };
  const key = publicRsaKey(matches[0]);
  if (!key) return { ok: false, reason: 'invalid_jwks' };
  try {
    if (
      !verify(
        'RSA-SHA256',
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        {
          key,
          padding: constants.RSA_PKCS1_PADDING,
        },
        signature,
      )
    )
      return { ok: false, reason: 'invalid_signature' };
  } catch {
    return { ok: false, reason: 'invalid_signature' };
  }
  const { exp, iat, nbf } = claims;
  if (
    !Number.isSafeInteger(nowSeconds) ||
    typeof expectedSubject !== 'string' ||
    expectedSubject.length === 0 ||
    claims.iss !== ISSUER ||
    claims.aud !== AUDIENCE ||
    claims.sub !== expectedSubject ||
    typeof exp !== 'number' ||
    !Number.isSafeInteger(exp) ||
    typeof iat !== 'number' ||
    !Number.isSafeInteger(iat) ||
    typeof nbf !== 'number' ||
    !Number.isSafeInteger(nbf) ||
    exp <= iat ||
    exp - iat > 3600 ||
    nbf > exp ||
    iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    nbf > nowSeconds + CLOCK_SKEW_SECONDS ||
    exp <= nowSeconds - CLOCK_SKEW_SECONDS
  )
    return { ok: false, reason: 'invalid_claims' };
  return { ok: true };
}

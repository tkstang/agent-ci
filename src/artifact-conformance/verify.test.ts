import { constants, generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { verifyConformanceToken } from './verify.js';

// Ephemeral synthetic keys exercise actual RSA verification; no credentials or
// token fixtures are persisted, and only the external JWKS transport is replaced.
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = {
  ...pair.publicKey.export({ format: 'jwk' }),
  kid: 'synthetic-key',
  use: 'sig',
  alg: 'RS256',
};
const NOW = 1_800_000_000;
const SUBJECT = 'repo:synthetic/example:ref:refs/heads/main';
const claims = {
  iss: 'https://token.actions.githubusercontent.com',
  aud: 'urn:agent-ci:artifact-conformance:v1',
  sub: SUBJECT,
  iat: NOW - 10,
  nbf: NOW - 10,
  exp: NOW + 290,
};

function token(
  payload: Record<string, unknown> = claims,
  header: Record<string, unknown> = { alg: 'RS256', kid: publicKey.kid },
  rawPayload?: string,
  rawHeader?: string,
): string {
  const input = [
    rawHeader ?? JSON.stringify(header),
    rawPayload ?? JSON.stringify(payload),
  ]
    .map((part) => Buffer.from(part).toString('base64url'))
    .join('.');
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), {
    key: pair.privateKey,
    padding: constants.RSA_PKCS1_PADDING,
  }).toString('base64url')}`;
}

function transport(keys: unknown[] = [publicKey]) {
  return vi.fn<typeof fetch>(async () => Response.json({ keys }));
}

describe('synthetic conformance token authentication', () => {
  it('verifies real RSA signatures against a fresh fixed unauthenticated JWKS request', async () => {
    const request = transport();
    expect(
      await verifyConformanceToken(token(), SUBJECT, request, NOW),
    ).toEqual({ ok: true });
    expect(
      await verifyConformanceToken(token(), SUBJECT, request, NOW),
    ).toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe(
      'https://token.actions.githubusercontent.com/.well-known/jwks',
    );
    expect(options).toMatchObject({
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/json' },
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects payload tampering and a same-kid key substitution', async () => {
    const parts = token().split('.');
    parts[1] = Buffer.from(
      JSON.stringify({ ...claims, sub: 'different' }),
    ).toString('base64url');
    expect(
      await verifyConformanceToken(parts.join('.'), SUBJECT, transport(), NOW),
    ).toEqual({ ok: false, reason: 'invalid_signature' });
    const wrongKey = {
      ...publicKey,
      ...otherPair.publicKey.export({ format: 'jwk' }),
    };
    expect(
      await verifyConformanceToken(
        token(),
        SUBJECT,
        transport([wrongKey]),
        NOW,
      ),
    ).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it.each([
    ['different issuer', { iss: 'https://example.invalid' }],
    ['missing audience', { aud: undefined }],
    ['wrong audience', { aud: 'different' }],
    ['audience array', { aud: [claims.aud] }],
    ['missing subject', { sub: undefined }],
    ['different subject', { sub: 'different' }],
    ['expired', { exp: NOW - 60, iat: NOW - 300, nbf: NOW - 300 }],
    ['future issue time', { iat: NOW + 61, exp: NOW + 300 }],
    ['future not-before', { nbf: NOW + 61 }],
    ['missing issue time', { iat: undefined }],
    ['missing expiry', { exp: undefined }],
    ['missing not-before', { nbf: undefined }],
    ['fractional expiry', { exp: NOW + 0.5 }],
    ['unsafe issue time', { iat: Number.MAX_SAFE_INTEGER + 1 }],
    ['string timestamp', { exp: String(NOW + 300) }],
    ['empty lifetime', { exp: claims.iat }],
    ['excessive lifetime', { exp: claims.iat + 3601 }],
    ['not-before after expiry', { nbf: claims.exp + 1 }],
  ])('rejects signed claims with %s', async (_name, patch) => {
    expect(
      await verifyConformanceToken(
        token({ ...claims, ...patch }),
        SUBJECT,
        transport(),
        NOW,
      ),
    ).toEqual({ ok: false, reason: 'invalid_claims' });
  });

  it('enforces the exact subject contract and the 60-second clock tolerance', async () => {
    expect(await verifyConformanceToken(token(), '', transport(), NOW)).toEqual(
      { ok: false, reason: 'invalid_claims' },
    );
    expect(
      await verifyConformanceToken(
        token(),
        `${SUBJECT}:suffix`,
        transport(),
        NOW,
      ),
    ).toEqual({ ok: false, reason: 'invalid_claims' });
    expect(
      await verifyConformanceToken(token(), SUBJECT, transport(), Number.NaN),
    ).toEqual({ ok: false, reason: 'invalid_claims' });
    expect(
      await verifyConformanceToken(
        token({ ...claims, iat: NOW + 60, nbf: NOW + 60 }),
        SUBJECT,
        transport(),
        NOW,
      ),
    ).toEqual({ ok: true });
    expect(
      await verifyConformanceToken(
        token({ ...claims, exp: NOW - 59, iat: NOW - 300, nbf: NOW - 300 }),
        SUBJECT,
        transport(),
        NOW,
      ),
    ).toEqual({ ok: true });
  });

  it.each([
    { alg: 'none' },
    { alg: 'HS256' },
    { alg: 'PS256' },
    { kid: '' },
    { kid: 'x'.repeat(257) },
    { jwk: publicKey },
    { jku: 'https://example.invalid/keys' },
    { x5u: 'https://example.invalid/cert' },
    { x5c: [] },
    { crit: [] },
    { b64: true },
  ])(
    'rejects unsafe JOSE headers without any network request: %j',
    async (patch) => {
      const request = transport();
      expect(
        await verifyConformanceToken(
          token(claims, { alg: 'RS256', kid: publicKey.kid, ...patch }),
          SUBJECT,
          request,
          NOW,
        ),
      ).toEqual({ ok: false, reason: 'invalid_header' });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['unknown kid', [{ ...publicKey, kid: 'different' }]],
    ['duplicate kid', [publicKey, publicKey]],
    ['empty key set', []],
    ['excessive key set', Array.from({ length: 17 }, () => publicKey)],
    ['symmetric key', [{ ...publicKey, kty: 'oct' }]],
    ['encryption key', [{ ...publicKey, use: 'enc' }]],
    ['missing use', [{ ...publicKey, use: undefined }]],
    ['wrong algorithm', [{ ...publicKey, alg: 'RS512' }]],
    ['missing algorithm', [{ ...publicKey, alg: undefined }]],
    ['signing operation', [{ ...publicKey, key_ops: ['sign'] }]],
    ['ambiguous operations', [{ ...publicKey, key_ops: ['verify', 'verify'] }]],
    ['private material', [{ ...publicKey, d: 'synthetic' }]],
    ['private primes', [{ ...publicKey, p: 'synthetic' }]],
    ['noncanonical modulus', [{ ...publicKey, n: `${publicKey.n}=` }]],
    [
      'short modulus',
      [{ ...publicKey, n: Buffer.alloc(255, 255).toString('base64url') }],
    ],
    [
      'oversize modulus',
      [{ ...publicKey, n: Buffer.alloc(513, 255).toString('base64url') }],
    ],
    ['even exponent', [{ ...publicKey, e: 'BA' }]],
    ['zero exponent', [{ ...publicKey, e: 'AA' }]],
  ])('rejects %s', async (_name, keys) => {
    expect(
      await verifyConformanceToken(token(), SUBJECT, transport(keys), NOW),
    ).toEqual({ ok: false, reason: 'invalid_jwks' });
  });

  it('accepts an explicitly verification-only public JWK', async () => {
    expect(
      await verifyConformanceToken(
        token(),
        SUBJECT,
        transport([{ ...publicKey, key_ops: ['verify'] }]),
        NOW,
      ),
    ).toEqual({ ok: true });
  });

  it('rejects oversized, noncanonical, non-object, and duplicate-key JWTs before fetching keys', async () => {
    const valid = token();
    const parts = valid.split('.');
    const malformed = [
      'x'.repeat(24 * 1024 + 1),
      'a.b',
      `${parts[0]}=.${parts[1]}.${parts[2]}`,
      token(claims, undefined, '[]'),
      token(claims, undefined, '{"sub":"first","s\\u0075b":"second"}'),
      token(
        claims,
        undefined,
        undefined,
        '{"alg":"RS256","alg":"RS256","kid":"synthetic-key"}',
      ),
      token(claims, {
        alg: 'RS256',
        kid: publicKey.kid,
        padding: 'x'.repeat(4096),
      }),
    ];
    for (const candidate of malformed) {
      const request = transport();
      expect(
        await verifyConformanceToken(candidate, SUBJECT, request, NOW),
      ).toEqual({ ok: false, reason: 'invalid_token' });
      expect(request).not.toHaveBeenCalled();
    }
  });

  it('fails closed on redirects, network failures, malformed JSON, duplicate JSON keys and body limits', async () => {
    const requests = [
      vi.fn<typeof fetch>(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://example.invalid' },
          }),
      ),
      vi.fn<typeof fetch>(async () => {
        throw new Error('synthetic transport detail never returned');
      }),
      vi.fn<typeof fetch>(async () => new Response('{')),
      vi.fn<typeof fetch>(async () => new Response('{"keys":[],"keys":[]}')),
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({
              keys: [publicKey],
              padding: 'x'.repeat(64 * 1024),
            }),
          ),
      ),
      vi.fn<typeof fetch>(
        async () =>
          new Response('{}', { headers: { 'content-length': '65537' } }),
      ),
    ];
    for (const request of requests) {
      expect(
        await verifyConformanceToken(token(), SUBJECT, request, NOW),
      ).toEqual({ ok: false, reason: 'jwks_unavailable' });
    }
  });

  it.each(['request', 'body'])(
    'bounds a stalled %s to ten seconds and aborts it',
    async (stage) => {
      vi.useFakeTimers();
      try {
        let signal: AbortSignal | null | undefined;
        const request = vi.fn<typeof fetch>(async (_url, options) => {
          signal = options?.signal;
          if (stage === 'request')
            return new Promise<Response>(() => undefined);
          return new Response(new ReadableStream<Uint8Array>({ start() {} }));
        });
        const result = verifyConformanceToken(token(), SUBJECT, request, NOW);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(await result).toEqual({ ok: false, reason: 'jwks_unavailable' });
        expect(signal?.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import type { Route } from '@agent-ci/routing/schema.js';

/** Loopback protocol fixture: real fetch, never a model or credential service. */
export async function responsesServer(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('no loopback port');
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    route: {
      id: 'sol-low',
      model: 'gpt-6.1-sol-low',
      providerModel: 'gpt-6.1-sol',
      effort: 'low',
      harness: 'codex',
      family: 'openai',
      account: 'pool',
      billing: 'subscription',
      credentials: ['AGENT_CI_PROXY_API_KEY'],
      login: false,
      baseUrl: `${origin}/v1`,
      structuredOutput: 'output-schema',
      qualified: null,
    } satisfies Route,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
        server.closeAllConnections();
      }),
  };
}

export function completedResponse(answer: unknown = { operations: [] }) {
  return {
    id: 'resp_synthetic_001',
    object: 'response',
    status: 'completed',
    error: null,
    incomplete_details: null,
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(answer) }],
      },
    ],
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      input_tokens_details: { cached_tokens: 2 },
    },
  };
}

export async function requestBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
    string,
    unknown
  >;
}

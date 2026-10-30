import type { RunResult } from '@agent-ci/contracts/run-result.js';
import { failure, success, type Result } from '@agent-ci/result.js';

/**
 * Optional notification: one JSON `{text}` POST to an incoming webhook (Slack
 * and compatible receivers). The webhook URL is a secret: it is read from the
 * environment, must be https, and never appears in a message.
 */

export interface NotifyOptions {
  readonly webhookUrl: string | undefined;
  readonly result: RunResult;
  readonly repo?: string | undefined;
  readonly pullUrl?: string | undefined;
  readonly runUrl?: string | undefined;
  readonly fetch?: typeof fetch;
}

export type NotifyReport =
  | { readonly sent: true }
  | { readonly sent: false; readonly reason: string };

const plain = (text: string, max: number) =>
  text.replaceAll(/[<>&]/gu, ' ').replaceAll(/\s+/gu, ' ').trim().slice(0, max);

export function renderNotification(options: NotifyOptions): string {
  const { result } = options;
  return [
    `agent-ci ${plain(result.useCase, 100)}${options.repo === undefined ? '' : ` on ${plain(options.repo, 100)}`}: ${result.status}${result.ok ? '' : ' (failed)'}`,
    plain(result.summary, 500),
    ...(options.pullUrl === undefined
      ? []
      : [`Pull request: ${options.pullUrl}`]),
    ...(options.runUrl === undefined ? [] : [`Run: ${options.runUrl}`]),
  ].join('\n');
}

export async function notify(
  options: NotifyOptions,
): Promise<Result<NotifyReport>> {
  if (options.webhookUrl === undefined || options.webhookUrl === '') {
    return success({ sent: false, reason: 'no webhook configured' });
  }
  let url: URL;
  try {
    url = new URL(options.webhookUrl);
  } catch {
    return failure('E_PUBLISH', 'the notification webhook is not a URL');
  }
  if (url.protocol !== 'https:') {
    return failure('E_PUBLISH', 'the notification webhook must use https');
  }
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: renderNotification(options) }),
    });
    if (!response.ok) {
      return failure(
        'E_PUBLISH',
        `the notification webhook returned ${response.status}`,
      );
    }
  } catch {
    return failure(
      'E_PUBLISH',
      'the notification webhook could not be reached',
    );
  }
  return success({ sent: true });
}

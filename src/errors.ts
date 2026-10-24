import type { ReReadableResponse } from './re-readable-response';

/** The server responded with a non-2xx status. */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly response: ReReadableResponse;

  constructor(response: ReReadableResponse) {
    super(`Request failed with status ${response.status}`);
    this.status = response.status;
    this.response = response;
  }
}

/** The request produced no response: network failure, CORS, abort, or timeout. */
export class NetworkError extends Error {
  override name = 'NetworkError';
  readonly status = -1;

  constructor(cause: unknown) {
    super('Network request failed', { cause });
  }
}

/** Wraps any thrown value in an `Error` whose `cause` is that value. */
export function toError(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(message, { cause });
}

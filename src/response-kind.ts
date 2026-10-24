import type { FetchResult } from './non-throwing-fetch';
import { ReReadableResponse } from './re-readable-response';
import { getStreamProtocol } from './stream-protocol';

// Brands keep a `false` result from ruling out `ReReadableResponse` in the other branch.
declare const streaming: unique symbol;
declare const unary: unique symbol;

export type StreamingResponse<TBody = unknown> = ReReadableResponse<TBody> & { readonly [streaming]: true };
export type UnaryResponse<TBody = unknown> = ReReadableResponse<TBody> & { readonly [unary]: true };

/** Whether the result is a successful response with an SSE or multipart `Content-Type`. */
export function isStreamingResponse<TBody>(result: FetchResult<TBody>): result is StreamingResponse<TBody> {
  return result instanceof ReReadableResponse && getStreamProtocol(result.headers.get('content-type')) !== undefined;
}

/** Whether the result is a successful response with any other `Content-Type`. */
export function isUnaryResponse<TBody>(result: FetchResult<TBody>): result is UnaryResponse<TBody> {
  return result instanceof ReReadableResponse && getStreamProtocol(result.headers.get('content-type')) === undefined;
}

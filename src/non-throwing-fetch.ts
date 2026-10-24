import { ApiError, NetworkError, toError } from "./errors";
import { ReReadableResponse } from "./re-readable-response";

export type FetchResult<TBody = unknown> =
  | ReReadableResponse<TBody>
  | ApiError
  | NetworkError
  | Error;

/**
 * Like `fetch` called with a url and init, but always resolves and never rejects.
 *
 * The body type is chosen per call, as in `fetch<User[]>("/users")`, and must fit
 * `TBase`, the body type that the fetch's middleware works with.
 */
export type NonThrowingFetch<TBase = unknown> = <TBody extends TBase = TBase>(
  url: string | URL,
  init?: RequestInit,
) => Promise<FetchResult<TBody>>;

/**
 * The base fetch. Makes one request and resolves to a `ReReadableResponse` for
 * a 2xx status, an `ApiError` for any other status, a `NetworkError` when
 * there's no response, or an `Error` for anything else.
 */
export async function nonThrowingFetch<TBody = unknown>(
  url: string | URL,
  init: RequestInit = {},
): Promise<FetchResult<TBody>> {
  try {
    // Build the Request up front so an invalid url or init resolves to an Error, not a NetworkError.
    const request = new Request(url, init);
    let response: Response;
    try {
      response = await globalThis.fetch(request);
    } catch (error) {
      return new NetworkError(error);
    }
    const result = new ReReadableResponse<TBody>(response);
    return result.ok ? result : new ApiError(result);
  } catch (error) {
    return toError(error);
  }
}

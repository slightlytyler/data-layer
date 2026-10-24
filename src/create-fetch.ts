import { composeMiddleware, type BodyMiddleware } from './compose-middleware';
import { toError } from './errors';
import { nonThrowingFetch, type FetchResult, type NonThrowingFetch } from './non-throwing-fetch';

export interface CreateFetchOptions<TBase = unknown> {
  middleware?: BodyMiddleware<TBase>[];
}

/**
 * Creates a non-throwing fetch by composing middleware around `nonThrowingFetch`.
 * `TBase` is inferred from the middleware: `unknown` unless body-aware middleware
 * narrows it.
 */
export function createFetch<TBase = unknown>({
  middleware = [],
}: CreateFetchOptions<TBase> = {}): NonThrowingFetch<TBase> {
  // Pass TBase explicitly, or it's inferred as unknown from nonThrowingFetch.
  const fetch = composeMiddleware<TBase>(middleware, nonThrowingFetch);
  // Callers can leave out init, but middleware always receives one.
  const nonThrowing = async (url: string | URL, init: RequestInit = {}): Promise<FetchResult<TBase>> => {
    try {
      return await fetch(url, init);
    } catch (error) {
      return toError(error);
    }
  };
  // The chain runs at the base type. Each call's body type is an assertion made here.
  return nonThrowing as NonThrowingFetch<TBase>;
}

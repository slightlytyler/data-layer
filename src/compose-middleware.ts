import type { FetchResult, NonThrowingFetch } from './non-throwing-fetch';

/**
 * A `NonThrowingFetch` whose init is always present, at the base body type
 * `TBase`. Middleware receives and returns one.
 */
export type MiddlewareFetch<TBase = unknown> = (
  ...args: Required<Parameters<NonThrowingFetch>>
) => Promise<FetchResult<TBase>>;

/**
 * Body-agnostic middleware, such as auth or metrics. It's generic over the body
 * type, so it fits any stack.
 */
export type Middleware = <TBase>(next: MiddlewareFetch<TBase>) => MiddlewareFetch<TBase>;

/**
 * Body-aware middleware, which treats every body as `TBase`. A fetch created with
 * it only accepts per-call body types that fit `TBase`.
 */
export type BodyMiddleware<TBase> = (next: MiddlewareFetch<TBase>) => MiddlewareFetch<TBase>;

/** Wraps each middleware around the one after it, with `next` innermost. */
export function composeMiddleware<TBase>(
  middleware: BodyMiddleware<TBase>[],
  next: MiddlewareFetch<TBase>,
): MiddlewareFetch<TBase> {
  return middleware.reduceRight((inner, current) => current(inner), next);
}

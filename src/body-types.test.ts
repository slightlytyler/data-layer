// Type-level tests for body typing. They're checked by `pnpm typecheck`; at runtime
// each test only makes sure its checks compile, and never makes a request.
import { describe, expectTypeOf, it } from 'vitest';
import type { BodyMiddleware, Middleware } from './compose-middleware';
import { createFetch } from './create-fetch';
import type { ApiError } from './errors';
import { nonThrowingFetch, type FetchResult } from './non-throwing-fetch';
import type { ReReadableAsyncIterable, StreamValue } from './re-readable-async-iterable';
import type { ReReadableResponse } from './re-readable-response';
import { isStreamingResponse, isUnaryResponse } from './response-kind';

interface User {
  id: string;
}

interface GraphqlResponse<TData = Record<string, unknown>> {
  data?: TData;
  errors?: { message: string }[];
  hasNext?: boolean;
}

type GraphqlMiddleware = BodyMiddleware<GraphqlResponse>;

const auth: Middleware = (next) => async (url, init) => {
  const headers = new Headers(init.headers);
  headers.set('authorization', 'Bearer token');
  return next(url, { ...init, headers });
};

const graphqlErrors: GraphqlMiddleware = (next) => async (url, init) => {
  const result = await next(url, init);
  if (isUnaryResponse(result)) {
    expectTypeOf(await result.json()).toEqualTypeOf<GraphqlResponse>();
  } else if (isStreamingResponse(result)) {
    expectTypeOf(result.iterable()).toEqualTypeOf<ReReadableAsyncIterable<GraphqlResponse>>();
  }
  return result;
};

describe('body types', () => {
  it('chooses the body type per call', () => {
    const fetch = createFetch({ middleware: [auth] });

    expectTypeOf(fetch<User[]>).returns.resolves.toEqualTypeOf<FetchResult<User[]>>();
    expectTypeOf(fetch).returns.resolves.toEqualTypeOf<FetchResult<unknown>>();
    expectTypeOf(nonThrowingFetch<User>).returns.resolves.toEqualTypeOf<FetchResult<User>>();
  });

  it('types json() and iterable() from the response', () => {
    expectTypeOf<ReReadableResponse<User>['json']>().returns.toEqualTypeOf<Promise<User>>();
    expectTypeOf<ReReadableResponse<User>['iterable']>().returns.toEqualTypeOf<ReReadableAsyncIterable<User>>();
    expectTypeOf<ReturnType<ReReadableAsyncIterable<User>[typeof Symbol.asyncIterator]>>().toEqualTypeOf<
      AsyncIterator<StreamValue<User>>
    >();
  });

  it('keeps the body type when isStreamingResponse and isUnaryResponse narrow', () => {
    const check = (result: FetchResult<User>) => {
      if (isUnaryResponse(result)) expectTypeOf(result.json()).toEqualTypeOf<Promise<User>>();
      if (isStreamingResponse(result)) expectTypeOf(result.iterable()).toEqualTypeOf<ReReadableAsyncIterable<User>>();
    };
    void check;
  });

  it('infers the base type from body-aware middleware, and lets each call refine it', () => {
    const graphqlFetch = createFetch({ middleware: [auth, graphqlErrors] });

    expectTypeOf(graphqlFetch).returns.resolves.toEqualTypeOf<FetchResult<GraphqlResponse>>();
    expectTypeOf(graphqlFetch<GraphqlResponse<{ me: User }>>).returns.resolves.toEqualTypeOf<
      FetchResult<GraphqlResponse<{ me: User }>>
    >();
  });

  it('rejects a per-call body type that does not fit the base type', () => {
    const graphqlFetch = createFetch({ middleware: [graphqlErrors] });
    const check = () => {
      // @ts-expect-error User[] doesn't fit GraphqlResponse
      void graphqlFetch<User[]>('/graphql');
    };
    void check;
  });

  it('rejects body-aware middleware in a stack with a different base type', () => {
    const check = () => {
      // @ts-expect-error a GraphqlMiddleware can't run in a stack of User[] bodies
      createFetch<User[]>({ middleware: [graphqlErrors] });
    };
    void check;
  });

  it('lets body-agnostic middleware fit any stack', () => {
    expectTypeOf(auth).toExtend<BodyMiddleware<User[]>>();
    expectTypeOf(auth).toExtend<GraphqlMiddleware>();
  });

  it('leaves ApiError bodies untyped', () => {
    expectTypeOf<ApiError['response']>().toEqualTypeOf<ReReadableResponse<unknown>>();
  });
});

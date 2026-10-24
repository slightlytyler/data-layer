import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { Middleware, MiddlewareFetch } from './compose-middleware';
import { createFetch } from './create-fetch';
import { ApiError, NetworkError } from './errors';
import { nonThrowingFetch } from './non-throwing-fetch';
import { ReReadableResponse } from './re-readable-response';
import { ENDPOINT, json, stubFetch } from './test-helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createFetch', () => {
  it('behaves like nonThrowingFetch with no options', async () => {
    stubFetch((request) => (request.url.endsWith('/missing') ? json({}, 404)() : json({ name: 'Ada' })()));
    const fetch = createFetch();

    const ok = await fetch(ENDPOINT);
    const missing = await fetch('https://api.test/missing');

    expect(ok).toBeInstanceOf(ReReadableResponse);
    expect(await (ok as ReReadableResponse).json()).toEqual({ name: 'Ada' });
    expect(missing).toBeInstanceOf(ApiError);
  });

  it('passes the url and init to the middleware, defaulting a missing init to {}', async () => {
    const seen: Parameters<MiddlewareFetch>[] = [];
    const log: Middleware = (next) => async (url, init) => {
      seen.push([url, init]);
      return next(url, init);
    };
    stubFetch(json({}));
    const fetch = createFetch({ middleware: [log] });
    const url = new URL(ENDPOINT);
    const init = { method: 'POST' };

    await fetch(url, init);
    await fetch(ENDPOINT);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.[0]).toBe(url);
    expect(seen[0]?.[1]).toBe(init);
    expect(seen[1]).toEqual([ENDPOINT, {}]);
  });

  it('makes init optional for callers and required for middleware', () => {
    // Checked by `pnpm typecheck`; a no-op at runtime.
    expectTypeOf(createFetch()).parameter(1).toEqualTypeOf<RequestInit | undefined>();
    expectTypeOf<Parameters<MiddlewareFetch>[1]>().toEqualTypeOf<RequestInit>();
    expectTypeOf(nonThrowingFetch).toExtend<MiddlewareFetch>();
  });

  it('resolves to an Error when a middleware throws', async () => {
    const cause = new Error('boom');
    stubFetch(json({}));
    const fetch = createFetch({
      middleware: [
        () => async () => {
          throw cause;
        },
      ],
    });

    const result = await fetch(ENDPOINT);

    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBeInstanceOf(ApiError);
    expect(result).not.toBeInstanceOf(NetworkError);
    expect((result as Error).cause).toBe(cause);
  });

  it('resolves to an Error when a middleware throws a non-Error value', async () => {
    stubFetch(json({}));
    const fetch = createFetch({
      middleware: [
        () => async () => {
          throw 'not an Error instance';
        },
      ],
    });

    const result = await fetch(ENDPOINT);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).cause).toBe('not an Error instance');
  });

  it('takes a url, not a Request object', () => {
    // Checked by `pnpm typecheck`; a no-op at runtime.
    expectTypeOf(createFetch()).parameter(0).toEqualTypeOf<string | URL>();
  });

  it('resolves an invalid request to an Error', async () => {
    stubFetch(json({}));
    const fetch = createFetch();

    const result = await fetch('not a url');

    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBeInstanceOf(NetworkError);
  });
});

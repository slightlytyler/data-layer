import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeMiddleware, type BodyMiddleware, type Middleware } from './compose-middleware';
import { ApiError } from './errors';
import { nonThrowingFetch } from './non-throwing-fetch';
import { ReReadableResponse } from './re-readable-response';
import { ENDPOINT, json, stubFetch } from './test-helpers';

const run = <TBase,>(middleware: BodyMiddleware<TBase>[], url = ENDPOINT, init: RequestInit = {}) =>
  composeMiddleware<TBase>(middleware, nonThrowingFetch)(url, init);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('composeMiddleware', () => {
  it('returns next unchanged when there is no middleware', () => {
    expect(composeMiddleware([], nonThrowingFetch)).toBe(nonThrowingFetch);
  });

  it('calls each middleware once when composing, not once per request', async () => {
    const setup = vi.fn<Middleware>((next) => next);
    stubFetch(json({}));

    const fetch = composeMiddleware([setup], nonThrowingFetch);
    await fetch(ENDPOINT, {});
    await fetch(ENDPOINT, {});

    expect(setup).toHaveBeenCalledTimes(1);
  });

  it('runs middleware in order on the way in and in reverse on the way out', async () => {
    const log: string[] = [];
    const tag =
      (name: string): Middleware =>
      (next) => async (url, init) => {
        log.push(`${name}:in`);
        const result = await next(url, init);
        log.push(`${name}:out`);
        return result;
      };
    stubFetch(() => {
      log.push('fetch');
      return Response.json({});
    });

    await run([tag('a'), tag('b'), tag('c')]);

    expect(log).toEqual(['a:in', 'b:in', 'c:in', 'fetch', 'c:out', 'b:out', 'a:out']);
  });

  it('lets every middleware and the caller read the body', async () => {
    const reads: unknown[] = [];
    const readJson: Middleware = (next) => async (url, init) => {
      const result = await next(url, init);
      if (result instanceof ReReadableResponse) reads.push(await result.json());
      return result;
    };
    const readText: Middleware = (next) => async (url, init) => {
      const result = await next(url, init);
      if (result instanceof ReReadableResponse) reads.push(await result.text());
      return result;
    };
    stubFetch(json({ name: 'Ada' }));

    const result = (await run([readJson, readText, readJson])) as ReReadableResponse;

    expect(reads).toEqual([{ name: 'Ada' }, '{"name":"Ada"}', { name: 'Ada' }]);
    expect(await result.json()).toEqual({ name: 'Ada' });
    expect(await result.text()).toBe('{"name":"Ada"}');
  });

  it('shows JSON mutated in place by an inner middleware to the outer middleware and the caller', async () => {
    let seenByOuter: unknown;
    const outer: Middleware = (next) => async (url, init) => {
      const result = await next(url, init);
      if (result instanceof ReReadableResponse) seenByOuter = structuredClone(await result.json());
      return result;
    };
    // Mutating the body needs to know its type, so this is body-aware middleware.
    const inner: BodyMiddleware<{ name: string; seen?: boolean }> = (next) => async (url, init) => {
      const result = await next(url, init);
      if (result instanceof ReReadableResponse) {
        const data = await result.json();
        data.name = data.name.toUpperCase();
        data.seen = true;
      }
      return result;
    };
    stubFetch(json({ name: 'Ada' }));

    const result = (await run([outer, inner])) as ReReadableResponse;

    expect(seenByOuter).toEqual({ name: 'ADA', seen: true });
    expect(await result.json()).toEqual({ name: 'ADA', seen: true });
  });

  it('shows text replaced by an inner middleware to the outer middleware and the caller', async () => {
    let seenByOuter: unknown;
    const outer: Middleware = (next) => async (url, init) => {
      const result = await next(url, init);
      if (result instanceof ReReadableResponse) seenByOuter = await result.text();
      return result;
    };
    const inner: Middleware = (next) => async (url, init) => {
      const result = await next(url, init);
      if (result instanceof ReReadableResponse) result.setText((await result.text()).toUpperCase());
      return result;
    };
    stubFetch(() => new Response('hello'));

    const result = (await run([outer, inner])) as ReReadableResponse;

    expect(seenByOuter).toBe('HELLO');
    expect(await result.text()).toBe('HELLO');
  });

  it('lets middleware change the url before calling next', async () => {
    const baseUrl: Middleware = (next) => (url, init) => next(new URL(url, 'https://api.test').href, init);
    stubFetch((request) => Response.json({ url: request.url }));

    const result = (await run([baseUrl], '/users')) as ReReadableResponse;

    expect(await result.json()).toEqual({ url: ENDPOINT });
  });

  it('lets middleware change the init before calling next', async () => {
    const auth: Middleware = (next) => (url, init) => {
      const headers = new Headers(init.headers);
      headers.set('authorization', 'Bearer token');
      return next(url, { ...init, headers });
    };
    stubFetch((request) =>
      Response.json({ auth: request.headers.get('authorization'), accept: request.headers.get('accept') }),
    );

    const result = (await run([auth], ENDPOINT, { headers: { accept: 'application/json' } })) as ReReadableResponse;

    expect(await result.json()).toEqual({ auth: 'Bearer token', accept: 'application/json' });
  });

  it('lets middleware short-circuit without calling next', async () => {
    const cache: Middleware = () => async () => new ReReadableResponse(Response.json({ cached: true }));
    const fetch = stubFetch(json({ cached: false }));

    const result = (await run([cache])) as ReReadableResponse;

    expect(await result.json()).toEqual({ cached: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('gives middleware classified results and lets it retry, including requests with a body', async () => {
    const bodies: string[] = [];
    const responses = [Response.json({}, { status: 503 }), Response.json({ ok: true })];
    stubFetch(async (request) => {
      bodies.push(await request.text());
      return responses.shift()!;
    });
    const retry: Middleware = (next) => async (url, init) => {
      const result = await next(url, init);
      return result instanceof ApiError && result.status === 503 ? next(url, init) : result;
    };

    const result = await run([retry], ENDPOINT, { method: 'POST', body: '{"name":"Ada"}' });

    expect(result).toBeInstanceOf(ReReadableResponse);
    expect(await (result as ReReadableResponse).json()).toEqual({ ok: true });
    expect(bodies).toEqual(['{"name":"Ada"}', '{"name":"Ada"}']);
  });

  it('rejects the outer middleware next call when an inner middleware throws', async () => {
    const cause = new Error('boom');
    let caught: unknown;
    const outer: Middleware = (next) => async (url, init) => {
      try {
        return await next(url, init);
      } catch (error) {
        caught = error;
        return new ReReadableResponse(Response.json({ recovered: true }));
      }
    };
    const inner: Middleware = () => async () => {
      throw cause;
    };
    stubFetch(json({}));

    const result = (await run([outer, inner])) as ReReadableResponse;

    expect(caught).toBe(cause);
    expect(await result.json()).toEqual({ recovered: true });
  });
});

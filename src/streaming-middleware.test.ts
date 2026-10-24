import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BodyMiddleware, Middleware } from './compose-middleware';
import { createFetch } from './create-fetch';
import { isStreamingResponse } from './response-kind';
import { collect, controlledStream, ENDPOINT, flush, streamingResponse, streamOf, stubFetch } from './test-helpers';

const read = async <TBase,>(middleware: BodyMiddleware<TBase>[]) => {
  const result = await createFetch({ middleware })(ENDPOINT);
  if (!isStreamingResponse(result)) throw new Error('expected a streaming response');
  return result;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('middleware with streaming responses', () => {
  it('shows an inner transform, including changes to control flow, to the outer middleware and the caller', async () => {
    stubFetch(() => streamingResponse(streamOf('data: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4\n\n')));
    const seenByOuter: unknown[] = [];
    const outer: Middleware = (next) => async (url, init) => {
      const result = await next(url, init);
      if (isStreamingResponse(result)) result.iterable().observe({ value: (value) => seenByOuter.push(value) });
      return result;
    };
    // Adding values needs to know their type, so this is body-aware middleware.
    const inner: BodyMiddleware<number | string> = (next) => async (url, init) => {
      const result = await next(url, init);
      if (isStreamingResponse(result)) {
        result.iterable().transform(async function* (source) {
          yield 'start'; // added
          for await (const value of source) {
            if (value === 2) continue; // dropped
            if (value === 4) return; // ended early
            yield value;
          }
        });
      }
      return result;
    };

    const result = await read([outer, inner]);

    expect(await collect(result.iterable())).toEqual(['start', 1, 3]);
    expect(seenByOuter).toEqual(['start', 1, 3]);
  });

  it('lets the caller receive values while the stream is still open', async () => {
    const { stream, push, close } = controlledStream();
    stubFetch(() => streamingResponse(stream));
    const transform: BodyMiddleware<number> = (next) => async (url, init) => {
      const result = await next(url, init);
      if (isStreamingResponse(result)) {
        result.iterable().transform(async function* (source) {
          for await (const value of source) yield typeof value === 'number' ? value * 10 : value;
        });
      }
      return result;
    };

    const result = await read([transform]);
    const received: unknown[] = [];
    const reading = (async () => {
      for await (const value of result.iterable()) received.push(value);
    })();
    push('data: 1\n\n');
    await flush();

    expect(received).toEqual([10]);
    push('data: 2\n\n');
    close();
    await reading;
    expect(received).toEqual([10, 20]);
  });

  it('lets a middleware observe the stream without taking values from the caller', async () => {
    stubFetch(() => streamingResponse(streamOf('data: 1\n\ndata: 2\n\n')));
    const logged: unknown[] = [];
    const logStream: Middleware = (next) => async (url, init) => {
      const result = await next(url, init);
      if (isStreamingResponse(result)) result.iterable().observe({ value: (value) => logged.push(value) });
      return result;
    };

    const result = await read([logStream]);

    expect(await collect(result.iterable())).toEqual([1, 2]);
    expect(logged).toEqual([1, 2]);
  });

  it('cancels the request when the caller stops early, even with middleware stages', async () => {
    const { stream, push, cancel } = controlledStream();
    stubFetch(() => streamingResponse(stream));
    const logStream: Middleware = (next) => async (url, init) => {
      const result = await next(url, init);
      if (isStreamingResponse(result)) result.iterable().observe({ value: () => {} });
      return result;
    };

    const result = await read([logStream]);
    push('data: 1\n\n');
    for await (const value of result.iterable()) if (value === 1) break;

    expect(cancel).toHaveBeenCalled();
  });

  it('resolves to an Error when a middleware calls iterable() on an invalid stream', async () => {
    stubFetch(() => streamingResponse(streamOf(''), 'multipart/mixed'));
    const reads: Middleware = (next) => async (url, init) => {
      const result = await next(url, init);
      if (isStreamingResponse(result)) result.iterable();
      return result;
    };

    const result = await createFetch({ middleware: [reads] })(ENDPOINT);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).cause).toBeInstanceOf(TypeError);
  });

  it('gives the caller an Error when a middleware iterates the stream itself', async () => {
    stubFetch(() => streamingResponse(streamOf('data: 1\n\n')));
    const consumes: Middleware = (next) => async (url, init) => {
      const result = await next(url, init);
      if (isStreamingResponse(result)) await collect(result.iterable());
      return result;
    };

    const result = await read([consumes]);
    const values = await collect(result.iterable());

    expect(values).toHaveLength(1);
    expect((values[0] as Error).message).toMatch(/transform\(\) or observe\(\)/);
  });
});

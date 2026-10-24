import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { ApiError, NetworkError } from './errors';
import { nonThrowingFetch } from './non-throwing-fetch';
import { ReReadableAsyncIterable } from './re-readable-async-iterable';
import { ReReadableResponse } from './re-readable-response';
import { isStreamingResponse, isUnaryResponse } from './response-kind';
import { collect, controlledStream, ENDPOINT, streamingResponse, streamOf, stubFetch } from './test-helpers';

const sse = (body: string) => new ReReadableResponse(streamingResponse(streamOf(body)));
const multipart = (body: string, contentType = 'multipart/mixed; boundary=abc') =>
  new ReReadableResponse(streamingResponse(streamOf(body), contentType));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isStreamingResponse and isUnaryResponse', () => {
  it.each([
    ['text/event-stream', true],
    ['text/event-stream; charset=utf-8', true],
    ['Text/Event-Stream', true],
    ['multipart/mixed; boundary="-"', true],
    ['multipart/mixed', true],
    ['application/json', false],
    ['multipart/form-data; boundary=abc', false],
  ])('classifies %s', (contentType, streaming) => {
    const response = new ReReadableResponse(new Response('', { headers: { 'content-type': contentType } }));

    expect(isStreamingResponse(response)).toBe(streaming);
    expect(isUnaryResponse(response)).toBe(!streaming);
  });

  it('treats a response with no Content-Type as unary', () => {
    const response = new ReReadableResponse(new Response(null));
    response.headers.delete('content-type');

    expect(isUnaryResponse(response)).toBe(true);
  });

  it('returns false for error results', () => {
    const errors = [new ApiError(sse('')), new NetworkError(new TypeError()), new Error()];
    for (const error of errors) {
      expect(isStreamingResponse(error)).toBe(false);
      expect(isUnaryResponse(error)).toBe(false);
    }
  });

  it('keeps ReReadableResponse in the other branch when it returns false', () => {
    const narrow = (result: Awaited<ReturnType<typeof nonThrowingFetch>>) => {
      if (isStreamingResponse(result)) return;
      if (result instanceof Error) return;
      expectTypeOf(result).toEqualTypeOf<ReReadableResponse>();
    };
    narrow(sse(''));
  });
});

describe('ReReadableResponse.iterable()', () => {
  it('yields parsed SSE payloads', async () => {
    expect(await collect(sse('data: {"n":1}\n\ndata: {"n":2}\n\n').iterable())).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('yields parsed multipart payloads, with a quoted boundary', async () => {
    const response = multipart('--a b\r\n\r\n1\r\n--a b--', 'multipart/mixed; boundary="a b"');

    expect(await collect(response.iterable())).toEqual([1]);
  });

  it('returns the same instance on every call', () => {
    const response = sse('');

    expect(response.iterable()).toBe(response.iterable());
    expect(response.iterable()).toBeInstanceOf(ReReadableAsyncIterable);
  });

  it('types the iterable from the response body type', () => {
    const typed = new ReReadableResponse<number>(streamingResponse(streamOf('')));

    expectTypeOf(sse('').iterable()).toEqualTypeOf<ReReadableAsyncIterable<unknown>>();
    expectTypeOf(typed.iterable()).toEqualTypeOf<ReReadableAsyncIterable<number>>();
  });

  it('can only be read once', async () => {
    const response = sse('data: 1\n\n');

    expect(await collect(response.iterable())).toEqual([1]);
    const [again] = await collect(response.iterable());

    expect(again).toBeInstanceOf(Error);
  });

  it('does not read the body until someone iterates', () => {
    const response = sse('data: 1\n\n');

    response.iterable();

    expect(response.body?.locked).toBe(false);
  });

  it.each([
    ['a unary response', () => new ReReadableResponse(Response.json({}))],
    ['multipart with no boundary', () => multipart('', 'multipart/mixed')],
    ['a response with no body', () => new ReReadableResponse(streamingResponse(null as never))],
  ])('throws a TypeError for %s', (_, create) => {
    const response = create();

    expect(() => response.iterable()).toThrow(TypeError);
  });

  it('throws on every call while the stream is invalid, rather than caching the failure', () => {
    const response = multipart('', 'multipart/mixed');

    expect(() => response.iterable()).toThrow(/no boundary/);
    expect(() => response.iterable()).toThrow(/no boundary/);
  });

  it('yields an Error as the last value when a payload is not JSON', async () => {
    const values = await collect(sse('data: 1\n\ndata: {oops\n\n').iterable());

    expect(values[0]).toBe(1);
    expect(values[1]).toBeInstanceOf(Error);
    expect((values[1] as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it('yields a NetworkError as the last value when the connection fails', async () => {
    const { stream, push, error } = controlledStream();
    const response = new ReReadableResponse(streamingResponse(stream));
    const values = collect(response.iterable());

    push('data: 1\n\n');
    error(new TypeError('connection reset'));

    const [first, last] = await values;
    expect(first).toBe(1);
    expect(last).toBeInstanceOf(NetworkError);
  });

  it('cancels the body when a consuming read stops early', async () => {
    const { stream, push, cancel } = controlledStream();
    const response = new ReReadableResponse(streamingResponse(stream));
    push('data: 1\n\n');

    for await (const value of response.iterable()) if (value === 1) break;

    expect(cancel).toHaveBeenCalled();
  });

  it('makes json() and text() reject after iterable()', async () => {
    const response = sse('data: 1\n\n');
    await collect(response.iterable());

    await expect(response.text()).rejects.toBeInstanceOf(TypeError);
    await expect(response.json()).rejects.toBeInstanceOf(TypeError);
  });

  it('makes iterable() throw after text()', async () => {
    const response = sse('data: 1\n\n');
    await response.text();

    expect(() => response.iterable()).toThrow(/already read as text/);
  });

  it('clone() of an invalid stream throws the same way from iterable()', () => {
    const response = multipart('', 'multipart/mixed');

    const copy = response.clone();

    expect(() => copy.iterable()).toThrow(/no boundary/);
  });

  it('clone() shares the stream', async () => {
    const response = sse('data: 1\n\n');
    response.iterable().transform(async function* (source) {
      for await (const value of source) yield typeof value === 'number' ? value + 1 : value;
    });

    const copy = response.clone();

    expect(copy.iterable()).toBe(response.iterable());
    expect(await collect(copy.iterable())).toEqual([2]);
  });
});

describe('nonThrowingFetch with a streaming response', () => {
  it('resolves an aborted stream to a NetworkError as its last value', async () => {
    const { stream, push, error } = controlledStream();
    stubFetch((request) => {
      // Like native fetch, aborting the request errors the body stream.
      request.signal.addEventListener('abort', () => error(request.signal.reason));
      return streamingResponse(stream);
    });
    const controller = new AbortController();

    const result = await nonThrowingFetch(ENDPOINT, { signal: controller.signal });
    if (!isStreamingResponse(result)) throw new Error('expected a streaming response');
    const values = collect(result.iterable());
    push('data: 1\n\n');
    controller.abort();

    const [first, last] = await values;
    expect(first).toBe(1);
    expect(last).toBeInstanceOf(NetworkError);
    expect(((last as NetworkError).cause as DOMException).name).toBe('AbortError');
  });
});

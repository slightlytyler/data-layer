import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from './errors';
import { nonThrowingFetch } from './non-throwing-fetch';
import { ReReadableResponse } from './re-readable-response';
import { ENDPOINT, hang, json, stubFetch } from './test-helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('nonThrowingFetch', () => {
  it('resolves a 2xx response to a ReReadableResponse', async () => {
    stubFetch(json({ name: 'Ada' }));

    const result = await nonThrowingFetch(ENDPOINT);

    expect(result).toBeInstanceOf(ReReadableResponse);
    expect(await (result as ReReadableResponse).json()).toEqual({ name: 'Ada' });
  });

  it.each([400, 401, 404, 500, 503])('resolves a %i response to an ApiError', async (status) => {
    stubFetch(json({ message: 'nope' }, status));

    const result = await nonThrowingFetch(ENDPOINT);

    expect(result).toBeInstanceOf(ApiError);
    const error = result as ApiError;
    expect(error.status).toBe(status);
    expect(await error.response.json()).toEqual({ message: 'nope' });
  });

  it('resolves a rejected native fetch to a NetworkError', async () => {
    const cause = new TypeError('fetch failed');
    stubFetch(() => {
      throw cause;
    });

    const result = await nonThrowingFetch(ENDPOINT);

    expect(result).toBeInstanceOf(NetworkError);
    expect((result as NetworkError).status).toBe(-1);
    expect((result as NetworkError).cause).toBe(cause);
  });

  it('resolves an aborted request to a NetworkError', async () => {
    stubFetch(hang);
    const controller = new AbortController();

    const pending = nonThrowingFetch(ENDPOINT, { signal: controller.signal });
    controller.abort();
    const result = await pending;

    expect(result).toBeInstanceOf(NetworkError);
    expect(((result as NetworkError).cause as DOMException).name).toBe('AbortError');
  });

  it('resolves an already-aborted request to a NetworkError', async () => {
    stubFetch(hang);

    const result = await nonThrowingFetch(ENDPOINT, { signal: AbortSignal.abort() });

    expect(result).toBeInstanceOf(NetworkError);
  });

  it('resolves a timed-out request to a NetworkError', async () => {
    stubFetch(hang);

    const result = await nonThrowingFetch(ENDPOINT, { signal: AbortSignal.timeout(10) });

    expect(result).toBeInstanceOf(NetworkError);
    expect(((result as NetworkError).cause as DOMException).name).toBe('TimeoutError');
  });

  it('resolves an invalid request to an Error, not a NetworkError', async () => {
    const fetch = stubFetch(json({}));

    const result = await nonThrowingFetch('not a url');

    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBeInstanceOf(NetworkError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts a URL object', async () => {
    const fetch = stubFetch(json({}));

    const result = await nonThrowingFetch(new URL(ENDPOINT));

    expect(result).toBeInstanceOf(ReReadableResponse);
    expect(fetch.mock.calls[0]?.[0]).toBeInstanceOf(Request);
    expect((fetch.mock.calls[0]?.[0] as Request).url).toBe(ENDPOINT);
  });

  it('can send the same init with a body more than once', async () => {
    const bodies: string[] = [];
    stubFetch(async (request) => {
      bodies.push(await request.text());
      return Response.json({});
    });
    const init = { method: 'POST', body: 'payload' };

    await nonThrowingFetch(ENDPOINT, init);
    await nonThrowingFetch(ENDPOINT, init);

    expect(bodies).toEqual(['payload', 'payload']);
  });
});

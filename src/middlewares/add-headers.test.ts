import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetch } from '../create-fetch';
import type { ReReadableResponse } from '../re-readable-response';
import { ENDPOINT, stubFetch } from '../test-helpers';
import { addHeaders } from './add-headers';

const echoHeaders = () =>
  stubFetch((request) => Response.json(Object.fromEntries(request.headers)));

const fetchWith = (headers: HeadersInit) =>
  createFetch({ middleware: [addHeaders({ headers: new Headers(headers) })] });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('addHeaders', () => {
  it('adds the headers to the request', async () => {
    echoHeaders();

    const result = (await fetchWith({ authorization: 'Bearer token' })(ENDPOINT)) as ReReadableResponse;

    expect(await result.json()).toMatchObject({ authorization: 'Bearer token' });
  });

  it('keeps the caller headers and overrides ones with the same name', async () => {
    echoHeaders();

    const result = (await fetchWith({ 'x-client': 'web' })(ENDPOINT, {
      headers: { accept: 'application/json', 'x-client': 'old' },
    })) as ReReadableResponse;

    expect(await result.json()).toMatchObject({ accept: 'application/json', 'x-client': 'web' });
  });

  it.each([
    ['a plain object', () => ({ accept: 'application/json' })],
    ['a Headers instance', () => new Headers({ accept: 'application/json' })],
    ['an array of pairs', () => [['accept', 'application/json']] as [string, string][]],
  ])('does not change the caller init when its headers are %s', async (_, createHeaders) => {
    echoHeaders();
    const headers = createHeaders();
    const init: RequestInit = { method: 'GET', headers };
    const before = new Headers(headers);

    await fetchWith({ authorization: 'Bearer token' })(ENDPOINT, init);

    expect(init.headers).toBe(headers);
    expect([...new Headers(init.headers)]).toEqual([...before]);
    expect(Object.keys(init)).toEqual(['method', 'headers']);
  });
});

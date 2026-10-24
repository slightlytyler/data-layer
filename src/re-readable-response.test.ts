import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReReadableResponse } from './re-readable-response';

const createResponse = (body: { name: string } = { name: 'Ada' }) => {
  const source = Response.json(body, { status: 201, statusText: 'Created', headers: { 'x-id': '1' } });
  // A constructed Response always has an empty url, so fake one that fetch would set.
  Object.defineProperty(source, 'url', { value: 'https://api.test/users' });
  return new ReReadableResponse<{ name: string }>(source);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReReadableResponse', () => {
  it('is a Response and keeps the standard properties', () => {
    const response = createResponse();

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Created');
    expect(response.ok).toBe(true);
    expect(response.headers.get('x-id')).toBe('1');
    expect(response.url).toBe('https://api.test/users');
  });

  it('returns equal values from repeated json() and text() calls in any order', async () => {
    const response = createResponse();

    expect(await response.json()).toEqual({ name: 'Ada' });
    expect(await response.text()).toBe('{"name":"Ada"}');
    expect(await response.json()).toEqual({ name: 'Ada' });
    expect(await response.text()).toBe('{"name":"Ada"}');

    const textFirst = createResponse();

    expect(await textFirst.text()).toBe('{"name":"Ada"}');
    expect(await textFirst.json()).toEqual({ name: 'Ada' });
  });

  it('reads the underlying body exactly once', async () => {
    const readBody = vi.spyOn(Response.prototype, 'text');
    const response = createResponse();

    await Promise.all([response.json(), response.text(), response.json(), response.text()]);

    expect(readBody).toHaveBeenCalledTimes(1);
  });

  it('returns the same JSON object so it can be mutated in place', async () => {
    const response = createResponse();

    const data = await response.json();
    data.name = 'Grace';

    expect(await response.json()).toBe(data);
    expect(await response.json()).toEqual({ name: 'Grace' });
  });

  it('replaces the text with setText', async () => {
    const response = createResponse();

    response.setText('replaced');

    expect(await response.text()).toBe('replaced');
    expect(await response.text()).toBe('replaced');
  });

  it('keeps separate caches for json() and text()', async () => {
    const response = createResponse();

    response.setText('replaced');
    const data = await response.json();
    data.name = 'Grace';

    expect(await response.json()).toEqual({ name: 'Grace' });
    expect(await response.text()).toBe('replaced');
  });

  it('clone() keeps the cached and mutated state', async () => {
    const response = createResponse();
    const data = await response.json();
    data.name = 'Grace';
    response.setText('replaced');

    const copy = response.clone();

    expect(copy).toBeInstanceOf(ReReadableResponse);
    expect(copy.status).toBe(201);
    expect(copy.headers.get('x-id')).toBe('1');
    expect(copy.url).toBe('https://api.test/users');
    expect(await copy.json()).toEqual({ name: 'Grace' });
    expect(await copy.text()).toBe('replaced');
  });

  it('clone() works before the body has been read', async () => {
    const response = createResponse();

    const copy = response.clone();

    expect(await copy.json()).toEqual({ name: 'Ada' });
    expect(await response.json()).toEqual({ name: 'Ada' });
  });

  it('clone() of a clone still reads the underlying body once', async () => {
    const readBody = vi.spyOn(Response.prototype, 'text');
    const response = createResponse();

    const copy = response.clone().clone();

    expect(await copy.text()).toBe('{"name":"Ada"}');
    expect(await response.text()).toBe('{"name":"Ada"}');
    expect(copy.url).toBe('https://api.test/users');
    expect(readBody).toHaveBeenCalledTimes(1);
  });
});

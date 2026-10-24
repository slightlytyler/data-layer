import { describe, expect, it } from 'vitest';
import { parseMultipart } from './parse-multipart';
import { chunkings, collect, controlledStream, streamOf } from './test-helpers';

const parse = (boundary: string, ...chunks: (string | Uint8Array)[]) =>
  collect(parseMultipart(streamOf(...chunks), boundary));

const part = (body: string) => `Content-Type: application/json\r\n\r\n${body}`;

describe('parseMultipart', () => {
  it('yields each part body as parsed JSON', async () => {
    const body = `--abc\r\n${part('{"n":1}')}\r\n--abc\r\n${part('{"n":2}')}\r\n--abc--\r\n`;

    expect(await parse('abc', body)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('ignores the preamble and the epilogue', async () => {
    const body = `preamble\r\n--abc\r\n${part('1')}\r\n--abc--\r\nepilogue\r\n--abc\r\n${part('2')}`;

    expect(await parse('abc', body)).toEqual([1]);
  });

  it('handles parts without headers, and skips empty parts', async () => {
    const body = '--abc\r\n\r\n1\r\n--abc\r\n\r\n\r\n--abc\r\nContent-Type: application/json\r\n\r\n\r\n--abc--';

    expect(await parse('abc', body)).toEqual([1]);
  });

  it('handles the GraphQL incremental delivery format', async () => {
    const body =
      '\r\n---\r\nContent-Type: application/json; charset=utf-8\r\n\r\n{"data":{"a":1},"hasNext":true}' +
      '\r\n---\r\nContent-Type: application/json; charset=utf-8\r\n\r\n{"incremental":[],"hasNext":false}' +
      '\r\n-----\r\n';

    expect(await parse('-', body)).toEqual([
      { data: { a: 1 }, hasNext: true },
      { incremental: [], hasNext: false },
    ]);
  });

  it('accepts transport padding after a delimiter', async () => {
    expect(await parse('abc', `--abc  \r\n${part('1')}\r\n--abc--`)).toEqual([1]);
  });

  it('parses correctly wherever the chunks split', async () => {
    const body = `--abc\r\n${part('{"emoji":"🚀"}')}\r\n--abc\r\n${part('"héllo"')}\r\n--abc--\r\n`;
    for (const chunks of chunkings(body)) {
      expect(await parse('abc', ...chunks)).toEqual([{ emoji: '🚀' }, 'héllo']);
    }
  });

  it('throws a SyntaxError for a body that is not JSON', async () => {
    await expect(parse('abc', `--abc\r\n${part('{oops')}\r\n--abc--`)).rejects.toBeInstanceOf(SyntaxError);
  });

  it('stops reading at the closing delimiter', async () => {
    const { stream, push, cancel } = controlledStream();
    push(`--abc\r\n${part('1')}\r\n--abc--\r\n`);

    expect(await collect(parseMultipart(stream, 'abc'))).toEqual([1]);
    expect(cancel).toHaveBeenCalled();
  });
});

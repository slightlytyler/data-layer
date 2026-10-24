import { describe, expect, it } from 'vitest';
import { NetworkError } from './errors';
import { parseSse } from './parse-sse';
import { chunkings, collect, controlledStream, streamOf } from './test-helpers';

const parse = (...chunks: (string | Uint8Array)[]) => collect(parseSse(streamOf(...chunks)));

describe('parseSse', () => {
  it('yields each event data as parsed JSON', async () => {
    expect(await parse('data: {"n":1}\n\ndata: {"n":2}\n\n')).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('joins multi-line data with a newline', async () => {
    expect(await parse('data: {"text":\ndata: "a"}\n\n')).toEqual([{ text: 'a' }]);
    expect(await parse('data: "line"\ndata:\n\n')).toEqual(['line']);
  });

  it('skips comments, events without data, and other fields', async () => {
    const body = ': keep-alive\n\nevent: ping\n\nevent: tick\nid: 7\nretry: 1000\ndata: 1\n\ndata:\n\n';

    expect(await parse(body)).toEqual([1]);
  });

  it('accepts data with or without a space after the colon', async () => {
    expect(await parse('data:1\n\ndata: 2\n\ndata:  3\n\n')).toEqual([1, 2, 3]);
  });

  it.each([
    ['\\r\\n', '\r\n'],
    ['\\n', '\n'],
    ['\\r', '\r'],
  ])('handles %s line endings', async (_, eol) => {
    expect(await parse(`data: 1${eol}${eol}data: 2${eol}${eol}`)).toEqual([1, 2]);
  });

  it('parses correctly wherever the chunks split', async () => {
    const body = 'data: {"emoji":"🚀","text":"héllo"}\r\n\r\ndata: 2\r\n\r\n';
    for (const chunks of chunkings(body)) {
      expect(await parse(...chunks)).toEqual([{ emoji: '🚀', text: 'héllo' }, 2]);
    }
  });

  it('drops an event that the stream ends before completing', async () => {
    expect(await parse('data: 1\n\ndata: 2\n')).toEqual([1]);
  });

  it('dispatches an event ended by a trailing \\r', async () => {
    expect(await parse('data: 1\r\r')).toEqual([1]);
  });

  it('throws a SyntaxError for data that is not JSON', async () => {
    await expect(parse('data: {oops\n\n')).rejects.toBeInstanceOf(SyntaxError);
  });

  it('throws a NetworkError when reading the body fails', async () => {
    const { stream, push, error } = controlledStream();
    const values: unknown[] = [];
    const reading = (async () => {
      for await (const value of parseSse(stream)) values.push(value);
    })();

    push('data: 1\n\n');
    error(new TypeError('connection reset'));

    await expect(reading).rejects.toBeInstanceOf(NetworkError);
    expect(values).toEqual([1]);
  });

  it('cancels the body when iteration stops early', async () => {
    const { stream, push, cancel } = controlledStream();
    push('data: 1\n\n');

    for await (const value of parseSse(stream)) if (value === 1) break;

    expect(cancel).toHaveBeenCalled();
  });
});

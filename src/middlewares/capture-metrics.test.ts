import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetch } from '../create-fetch';
import { ReReadableResponse } from '../re-readable-response';
import { isStreamingResponse } from '../response-kind';
import { collect, controlledStream, ENDPOINT, flush, streamingResponse, streamOf, stubFetch } from '../test-helpers';
import { captureMetrics, MetricType, type LogMetric } from './capture-metrics';

const setup = () => {
  const logMetric = vi.fn<LogMetric>();
  const fetch = createFetch({ middleware: [captureMetrics({ logMetric })] });
  const metric = (name: string) => logMetric.mock.calls.map(([args]) => args).filter((args) => args.name === name);
  const names = () => logMetric.mock.calls.map(([args]) => args.name);
  return { fetch, logMetric, metric, names };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('captureMetrics', () => {
  it('logs a request count tagged with the url without its query or hash', async () => {
    stubFetch(() => Response.json({}));
    const { fetch, metric } = setup();

    await fetch(`${ENDPOINT}?page=2#top`);

    expect(metric('request_count')).toEqual([
      { name: 'request_count', type: MetricType.COUNT, value: 1, tags: { clean_uri: ENDPOINT } },
    ]);
  });

  it('handles a relative url without failing the request', async () => {
    stubFetch(() => Response.json({}));
    const { fetch, metric } = setup();

    await fetch('/graphql?op=Me');

    expect(metric('request_count')[0]?.tags).toEqual({ clean_uri: '/graphql' });
  });

  it('gives each metric its own tags object', async () => {
    stubFetch(() => streamingResponse(streamOf('data: 1\n\n')));
    const { fetch, logMetric } = setup();

    const result = await fetch(ENDPOINT);
    if (isStreamingResponse(result)) await collect(result.iterable());

    const tags = logMetric.mock.calls.map(([args]) => args.tags);
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags[0]).toEqual({ clean_uri: ENDPOINT });
  });

  describe('unary responses', () => {
    it('logs time to first byte, time to complete, and size without delaying the response', async () => {
      stubFetch(() => Response.json({ name: 'Ada' }));
      const { fetch, metric, names } = setup();

      const result = (await fetch(ENDPOINT)) as ReReadableResponse;
      expect(names()).toEqual(['request_count', 'time_to_first_byte']);
      expect(await result.json()).toEqual({ name: 'Ada' });
      await flush();

      expect(names()).toEqual(['request_count', 'time_to_first_byte', 'time_to_complete', 'response_size']);
      expect(metric('time_to_first_byte')[0]?.tags).toEqual({ clean_uri: ENDPOINT, is_streaming: false });
      expect(metric('response_size')[0]?.value).toBeCloseTo(new TextEncoder().encode('{"name":"Ada"}').length / 1024);
    });

    it('skips completion metrics when the body fails to download', async () => {
      const { stream, error } = controlledStream();
      stubFetch(() => new Response(stream));
      const { fetch, names } = setup();

      const result = (await fetch(ENDPOINT)) as ReReadableResponse;
      error(new TypeError('connection reset'));
      await expect(result.text()).rejects.toThrow();
      await flush();

      expect(names()).toEqual(['request_count', 'time_to_first_byte']);
    });
  });

  describe('streaming responses', () => {
    it('lets the caller receive values while the stream is still open', async () => {
      const { stream, push, close } = controlledStream();
      stubFetch(() => streamingResponse(stream));
      const { fetch, names } = setup();

      const result = await fetch(ENDPOINT);
      if (!isStreamingResponse(result)) throw new Error('expected a streaming response');
      const received: unknown[] = [];
      const reading = (async () => {
        for await (const value of result.iterable()) received.push(value);
      })();
      push('data: {"n":1}\n\n');
      await flush();

      expect(received).toEqual([{ n: 1 }]);
      expect(names()).not.toContain('time_to_complete');
      push('data: {"n":2}\n\n');
      close();
      await reading;
      expect(received).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it('logs first-result metrics once, then completion metrics when the stream ends', async () => {
      stubFetch(() => streamingResponse(streamOf('data: {"n":1}\n\ndata: {"n":22}\n\n')));
      const { fetch, metric, names } = setup();

      const result = await fetch(ENDPOINT);
      if (isStreamingResponse(result)) await collect(result.iterable());

      expect(names()).toEqual([
        'request_count',
        'time_to_first_byte',
        'response_time_to_first_result',
        'response_first_result_size',
        'time_to_complete',
        'response_size',
      ]);
      const kb = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length / 1024;
      expect(metric('response_first_result_size')[0]?.value).toBeCloseTo(kb({ n: 1 }));
      expect(metric('response_size')[0]?.value).toBeCloseTo(kb({ n: 1 }) + kb({ n: 22 }));
      expect(metric('time_to_complete')[0]?.tags).toEqual({ clean_uri: ENDPOINT, is_streaming: true });
      // The time to first result is a duration, not the size the old code logged.
      expect(metric('response_time_to_first_result')[0]?.value).toBeGreaterThanOrEqual(
        metric('time_to_first_byte')[0]!.value,
      );
    });

    it('does not measure an error value, and still passes it to the caller', async () => {
      stubFetch(() => streamingResponse(streamOf('data: {"n":1}\n\ndata: {oops\n\n')));
      const { fetch, metric } = setup();

      const result = await fetch(ENDPOINT);
      const values = isStreamingResponse(result) ? await collect(result.iterable()) : [];

      expect(values[1]).toBeInstanceOf(Error);
      const kb = new TextEncoder().encode(JSON.stringify({ n: 1 })).length / 1024;
      expect(metric('response_size')[0]?.value).toBeCloseTo(kb);
    });

    it('skips completion metrics when the consumer stops early', async () => {
      stubFetch(() => streamingResponse(streamOf('data: 1\n\ndata: 2\n\n')));
      const { fetch, names } = setup();

      const result = await fetch(ENDPOINT);
      if (isStreamingResponse(result)) for await (const _ of result.iterable()) break;

      expect(names()).not.toContain('time_to_complete');
    });
  });
});

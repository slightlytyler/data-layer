import type { Middleware } from "../compose-middleware";
import { isStreamingResponse, isUnaryResponse } from "../response-kind";

export enum MetricType {
  COUNT,
  DISTRIBUTION,
}

export type LogMetric = (logMetricArgs: {
  name: string;
  type: MetricType;
  value: number;
  tags: Record<string, string | number | boolean>;
}) => void;

export type CaptureMetricsArgs = {
  logMetric: LogMetric;
};

// Plain string handling, because `new URL()` throws on relative urls like "/graphql".
const getCleanUri = (url: string | URL) => String(url).split(/[?#]/, 1)[0]!;

const getSizeInKB = (str: string) => {
  const bytes = new TextEncoder().encode(str).length;
  return bytes / 1024;
};

export const captureMetrics =
  (args: CaptureMetricsArgs): Middleware =>
  (next) =>
  async (url, init) => {
    const cleanUri = getCleanUri(url);
    args.logMetric({
      type: MetricType.COUNT,
      name: "request_count",
      value: 1,
      tags: { clean_uri: cleanUri },
    });
    const start = performance.now();
    const response = await next(url, init);
    // Each metric gets its own tags object, so later changes can't alter what was logged.
    const tags = {
      clean_uri: cleanUri,
      is_streaming: isStreamingResponse(response),
    };
    args.logMetric({
      name: "time_to_first_byte",
      type: MetricType.DISTRIBUTION,
      value: performance.now() - start,
      tags: { ...tags },
    });

    if (isUnaryResponse(response)) {
      // Start reading the body without awaiting it, so the caller isn't held back.
      // text() is cached, so the caller's own read costs nothing extra.
      void response.text().then(
        (text) => {
          args.logMetric({
            name: "time_to_complete",
            type: MetricType.DISTRIBUTION,
            value: performance.now() - start,
            tags: { ...tags },
          });
          args.logMetric({
            name: "response_size",
            type: MetricType.DISTRIBUTION,
            value: getSizeInKB(text),
            tags: { ...tags },
          });
        },
        // A body that fails to download has no completion time or size to report.
        () => {},
      );
    }

    if (isStreamingResponse(response)) {
      // Observe values as the caller reads them. Looping over the stream here would
      // hold the response back until the stream ended.
      let totalSize = 0;
      let isFirstResult = true;
      response.iterable().observe({
        value(result) {
          // An error is always the last value. It has no payload to measure.
          if (result instanceof Error) return;
          const size = getSizeInKB(JSON.stringify(result));
          totalSize += size;
          if (!isFirstResult) return;
          isFirstResult = false;
          args.logMetric({
            name: "response_time_to_first_result",
            type: MetricType.DISTRIBUTION,
            value: performance.now() - start,
            tags: { ...tags },
          });
          args.logMetric({
            name: "response_first_result_size",
            type: MetricType.DISTRIBUTION,
            value: size,
            tags: { ...tags },
          });
        },
        // Only called when the stream ends, not when the consumer stops early.
        end() {
          args.logMetric({
            name: "time_to_complete",
            type: MetricType.DISTRIBUTION,
            value: performance.now() - start,
            tags: { ...tags },
          });
          args.logMetric({
            name: "response_size",
            type: MetricType.DISTRIBUTION,
            value: totalSize,
            tags: { ...tags },
          });
        },
      });
    }

    return response;
  };

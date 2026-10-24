import { vi } from 'vitest';

export const ENDPOINT = 'https://api.test/users';

/** Replaces `globalThis.fetch` with a mock that hands the handler a real Request. */
export const stubFetch = (handler: (request: Request) => Response | Promise<Response>) => {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)));
  vi.stubGlobal('fetch', mock);
  return mock;
};

/** A handler that never responds and rejects when the request is aborted, like native fetch. */
export const hang = (request: Request) =>
  new Promise<Response>((_, reject) => {
    if (request.signal.aborted) reject(request.signal.reason);
    request.signal.addEventListener('abort', () => reject(request.signal.reason));
  });

export const json = (body: unknown, status = 200) => () => Response.json(body, { status });

export const encode = (text: string) => new TextEncoder().encode(text);

/** A body stream that emits each chunk in order, then closes. */
export const streamOf = (...chunks: (string | Uint8Array)[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encode(chunk) : chunk);
      controller.close();
    },
  });

/** A body stream that the test pushes chunks into. */
export const controlledStream = () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel,
  });
  return {
    stream,
    cancel,
    push: (text: string) => controller.enqueue(encode(text)),
    close: () => controller.close(),
    error: (reason: unknown) => controller.error(reason),
  };
};

/** Every way to split `text` into two byte chunks, plus one byte per chunk. */
export const chunkings = (text: string): Uint8Array[][] => {
  const bytes = encode(text);
  const splits = Array.from({ length: bytes.length - 1 }, (_, i) => [bytes.slice(0, i + 1), bytes.slice(i + 1)]);
  return [[bytes], ...splits, Array.from(bytes, (byte) => Uint8Array.of(byte))];
};

export const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
};

/** A streaming response, as `nonThrowingFetch` would build it. */
export const streamingResponse = (body: ReadableStream<Uint8Array>, contentType = 'text/event-stream') =>
  new Response(body, { headers: { 'content-type': contentType } });

/** Lets pending promise callbacks run. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

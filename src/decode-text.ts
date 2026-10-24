import { NetworkError } from './errors';

/**
 * Reads a byte stream and yields its text as UTF-8, a chunk at a time.
 * A failed read throws a `NetworkError`. If iteration stops before the stream
 * ends, the stream is cancelled.
 */
export async function* decodeText(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let finished = false;
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        finished = true;
        throw new NetworkError(error);
      }
      if (result.done) {
        finished = true;
        const rest = decoder.decode();
        if (rest) yield rest;
        return;
      }
      const text = decoder.decode(result.value, { stream: true });
      if (text) yield text;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

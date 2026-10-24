import { decodeText } from './decode-text';

/**
 * Parses a `text/event-stream` body and yields each event's `data` as parsed
 * JSON. Event names, ids, and retry fields are dropped.
 */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  let data: string[] = [];
  for await (const line of splitLines(decodeText(stream))) {
    if (line === '') {
      // A blank line ends the event. Events without data, like keep-alives, are skipped.
      const payload = data.join('\n');
      data = [];
      if (payload.trim() !== '') yield JSON.parse(payload);
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') continue;
    const value = colon === -1 ? '' : line.slice(colon + 1);
    data.push(value.startsWith(' ') ? value.slice(1) : value);
  }
}

/** Splits text into lines ending in `\r\n`, `\n`, or `\r`. */
async function* splitLines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += chunk;
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const char = buffer[i];
      if (char === '\n') {
        yield buffer.slice(start, i);
        start = i + 1;
      } else if (char === '\r') {
        // A trailing `\r` might be the first half of `\r\n`, so wait for more text.
        if (i + 1 === buffer.length) break;
        yield buffer.slice(start, i);
        if (buffer[i + 1] === '\n') i++;
        start = i + 1;
      }
    }
    buffer = buffer.slice(start);
  }
  // A partial last line can't complete an event, so only a trailing `\r` matters.
  if (buffer.endsWith('\r')) yield buffer.slice(0, -1);
}

import { decodeText } from './decode-text';

/**
 * Parses a `multipart/mixed` body and yields each part's body as parsed JSON.
 * Part headers, empty parts, the preamble, and the epilogue are ignored.
 */
export async function* parseMultipart(stream: ReadableStream<Uint8Array>, boundary: string): AsyncGenerator<unknown> {
  const delimiter = `\r\n--${boundary}`;
  // Start with a CRLF so that a delimiter at the very start of the body is found too.
  let buffer = '\r\n';
  // False while reading the preamble, before the first delimiter.
  let inPart = false;
  for await (const chunk of decodeText(stream)) {
    buffer += chunk;
    while (true) {
      const index = buffer.indexOf(delimiter);
      if (index === -1) break;
      const after = index + delimiter.length;
      const isClose = buffer.startsWith('--', after);
      // Wait until the rest of the delimiter line has arrived.
      const lineEnd = isClose ? after : buffer.indexOf('\r\n', after);
      if (lineEnd === -1) break;
      if (inPart) {
        const body = partBody(buffer.slice(0, index));
        if (body.trim() !== '') yield JSON.parse(body);
      }
      if (isClose) return;
      buffer = buffer.slice(lineEnd + 2);
      inPart = true;
    }
  }
}

/** A part is headers, a blank line, then the body. With no headers, it starts with the blank line. */
function partBody(part: string): string {
  if (part.startsWith('\r\n')) return part.slice(2);
  const headerEnd = part.indexOf('\r\n\r\n');
  return headerEnd === -1 ? '' : part.slice(headerEnd + 4);
}

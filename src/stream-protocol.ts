export type StreamProtocol = { type: 'sse' } | { type: 'multipart'; boundary: string | undefined };

/** Reads the streaming protocol from a `Content-Type`, or `undefined` for a unary response. */
export function getStreamProtocol(contentType: string | null): StreamProtocol | undefined {
  if (!contentType) return undefined;
  const [mediaType = '', ...params] = contentType.split(';');
  switch (mediaType.trim().toLowerCase()) {
    case 'text/event-stream':
      return { type: 'sse' };
    case 'multipart/mixed':
      return { type: 'multipart', boundary: getParam(params, 'boundary') };
    default:
      return undefined;
  }
}

function getParam(params: string[], name: string): string | undefined {
  for (const param of params) {
    const equals = param.indexOf('=');
    if (equals === -1 || param.slice(0, equals).trim().toLowerCase() !== name) continue;
    let value = param.slice(equals + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return value || undefined;
  }
  return undefined;
}

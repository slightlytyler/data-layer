import { parseMultipart } from "./parse-multipart";
import { parseSse } from "./parse-sse";
import {
  endOnError,
  ReReadableAsyncIterable,
} from "./re-readable-async-iterable";
import { getStreamProtocol } from "./stream-protocol";

/**
 * A `Response` whose body can be read any number of times.
 *
 * A unary body is read once, as text. `json()` parses that text once and
 * always returns the same object, so middleware can mutate it in place and
 * every later reader sees the change. `text()` can be replaced with `setText`.
 *
 * A streaming body (SSE or multipart) is read with `iterable()`, which always
 * returns the same `ReReadableAsyncIterable`. Middleware adds stages to it with
 * `transform()` and `observe()`, and the consumer reads it once.
 *
 * `TBody` is the parsed body type: what `json()` resolves to, and what each
 * stream value is. It is chosen per fetch call and is not checked at runtime.
 */
export class ReReadableResponse<TBody = unknown> extends Response {
  #url: string;
  #redirected: boolean;
  #type: ResponseType;
  // The original body text, read from the underlying stream at most once.
  #body: Promise<string> | undefined;
  #json: Promise<TBody> | undefined;
  // Replacement text set by `setText`. Undefined means "use the original body".
  #text: string | undefined;
  #iterable: ReReadableAsyncIterable<TBody> | undefined;
  // Whether the body was handed to a stream parser, so it can't be read as text.
  #streamed = false;
  // Set on a clone: the response it reads its body through, so the body is read once.
  #origin: ReReadableResponse<TBody> | undefined;

  constructor(response: Response) {
    super(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // The Response constructor can't set these, so carry them over by hand.
    this.#url = response.url;
    this.#redirected = response.redirected;
    this.#type = response.type;
  }

  override get url(): string {
    return this.#url;
  }

  override get redirected(): boolean {
    return this.#redirected;
  }

  override get type(): ResponseType {
    return this.#type;
  }

  override text(): Promise<string> {
    return this.#text === undefined
      ? this.#readBody()
      : Promise.resolve(this.#text);
  }

  setText(value: string): void {
    this.#text = value;
  }

  override json(): Promise<TBody> {
    this.#json ??= this.#readBody().then((text) => JSON.parse(text) as TBody);
    return this.#json;
  }

  iterable(): ReReadableAsyncIterable<TBody> {
    if (this.#origin) return this.#origin.iterable();
    if (!this.#iterable) {
      // All validation happens here, so the parsers can assume valid input.
      const protocol = getStreamProtocol(this.headers.get("content-type"));
      if (!protocol) {
        throw new TypeError("The response is not a streaming response.");
      }
      if (protocol.type === "multipart" && !protocol.boundary) {
        throw new TypeError("The multipart response has no boundary.");
      }
      if (this.#body) {
        throw new TypeError("The response body was already read as text.");
      }
      const body = this.body;
      if (!body) throw new TypeError("The response has no body.");
      // The parsers yield parsed JSON; its type is the caller's assertion.
      const values = (
        protocol.type === "sse"
          ? parseSse(body)
          : parseMultipart(body, protocol.boundary!)
      ) as AsyncIterable<TBody>;
      this.#streamed = true;
      this.#iterable = new ReReadableAsyncIterable(endOnError(values));
    }
    return this.#iterable;
  }

  override clone(): ReReadableResponse<TBody> {
    const copy = new ReReadableResponse<TBody>(new Response(null, this));
    copy.#url = this.#url;
    copy.#redirected = this.#redirected;
    copy.#type = this.#type;
    copy.#origin = this.#origin ?? this;
    copy.#json = this.#json;
    copy.#text = this.#text;
    return copy;
  }

  #readBody(): Promise<string> {
    if (this.#origin) return this.#origin.#readBody();
    this.#body ??= this.#streamed
      ? Promise.reject(
          new TypeError("The response body was already read as a stream."),
        )
      : super.text();
    return this.#body;
  }
}

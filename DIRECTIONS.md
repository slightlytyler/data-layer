# Data Layer library

We are building "the data layer": a frontend TypeScript networking library built on the native `fetch`. It has five core pieces:

1. **`nonThrowingFetch`**, the base fetch function. It makes one request and decides whether to resolve to a response or to an error. It never rejects.
2. **Middleware** extends request/response behavior. `composeMiddleware` composes a list of middleware around a fetch function.
3. **`createFetch`** is the entry point. It composes the library's default middleware and the consumer's middleware around `nonThrowingFetch`, and returns the resulting non-throwing fetch. Consumers configure it with options.
4. **`ReReadableResponse`** lets several middleware read, and change, the same response body. That body can be unary (JSON or text) or streaming (SSE or multipart).
5. **`ReReadableAsyncIterable`** is how streaming responses are read. Middleware adds stages to it that change or watch values, and the consumer reads it once. Every stage sees every value.

## Non-throwing fetch

The native `fetch` reports failures in two different ways. It rejects on network failures, but it resolves normally on HTTP error statuses (4xx/5xx), so callers need both `try/catch` and `response.ok` checks. Every fetch in the data layer has a single, uniform contract instead: it **always resolves and never rejects**.

```ts
type FetchResult<TBody = unknown> =
  | ReReadableResponse<TBody>
  | ApiError
  | NetworkError
  | Error;

type NonThrowingFetch<TBase = unknown> = <TBody extends TBase = TBase>(
  url: string | URL,
  init?: RequestInit,
) => Promise<FetchResult<TBody>>;
```

A non-throwing fetch takes a url and an optional init, like the most common way of calling `fetch`. It doesn't accept a `Request` object, so middleware always works with a url and init directly.

### Body types

The body type is chosen **per call**: `fetch<User[]>("/users")` types `json()` as `Promise<User[]>`, and every stream value as `User[]`. With no type argument, the body type is the fetch's base type, which is `unknown` unless body-aware middleware narrows it (see "Middleware").

- `TBody` is the body type of one call. It must fit `TBase`, the base type that the fetch's middleware works with.
- `ReReadableResponse<TBody>` carries the type. `json()` resolves to `TBody`, and `iterable()` returns a `ReReadableAsyncIterable<TBody>`. `isStreamingResponse` and `isUnaryResponse` keep the type when they narrow.
- **The type is an assertion, not a check.** The body is parsed JSON, and nothing verifies its shape at runtime.
- `ApiError.response` stays a `ReReadableResponse<unknown>`, because error bodies often have a different shape from success bodies.

### Base fetch

```ts
function nonThrowingFetch<TBody = unknown>(
  url: string | URL,
  init?: RequestInit,
): Promise<FetchResult<TBody>>;
```

`nonThrowingFetch` is the base fetch function. It holds all of the logic for deciding between a response and an error. It makes one request with no middleware involved:

- It builds a `Request` from the url and init, then sends it to `globalThis.fetch`. Building the `Request` first means an invalid url or init resolves to an `Error`, not a `NetworkError`.
- If `globalThis.fetch` rejects, it resolves to a `NetworkError`.
- Otherwise it wraps the response in a `ReReadableResponse`. A 2xx status resolves to that response, and any other status resolves to an `ApiError`.
- Anything else that throws resolves to an `Error`. This includes an invalid request, such as a malformed URL.

`nonThrowingFetch` is itself a `NonThrowingFetch`, so it can be used directly as the innermost step of a middleware chain.

### Handling results

Callers narrow the result with `instanceof`:

```ts
const result = await fetch("/api/users");
if (result instanceof ApiError) {
  /* server responded with a non-2xx status */
} else if (result instanceof NetworkError) {
  /* request never got a response */
} else if (result instanceof Error) {
  /* anything else */
} else {
  const users = await result.json();
}
```

If the result is a `ReReadableResponse`, the request succeeded: the status is always 2xx. Any other outcome resolves to an error type, so callers never need to check `response.ok`.

### Errors

`ApiError` and `NetworkError` both extend `Error`, so the `instanceof` checks must go from most specific to least specific, as in the example above.

| Class          | When                                                                                                                                                                                                                                                                                                                                | Properties                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ApiError`     | The server returned a response with a non-2xx status (`!response.ok`).                                                                                                                                                                                                                                                              | `status`: the HTTP status. `response`: the `ReReadableResponse`, so callers can read the error body.     |
| `NetworkError` | The request produced no response: the network is down, DNS failed, the server is unreachable, CORS blocked the request, or the request was aborted or timed out through an `AbortSignal`. In practice this is native `fetch` rejecting. Also used when a streaming response's connection fails partway through, including an abort. | `status`: always `-1`. `cause`: the original error, such as the `TypeError` or the abort `DOMException`. |
| `Error`        | Anything else: an exception thrown by middleware (including a `TypeError` from `iterable()` on an invalid stream), a body or stream value that failed to parse, or an invalid request.                                                                                                                                              | `cause`: the original error, when there is one.                                                          |

## Middleware

Middleware follows the "onion" model and uses partial application. A middleware takes `next`, the `MiddlewareFetch` after it in the chain, and returns a new `MiddlewareFetch` that wraps it. Write middleware with the `Middleware` type, or with `BodyMiddleware` when it needs to know the body type:

```ts
/** A NonThrowingFetch whose init is always present, at the base body type. */
type MiddlewareFetch<TBase = unknown> = (
  ...args: Required<Parameters<NonThrowingFetch>>
) => Promise<FetchResult<TBase>>;

/** Body-agnostic middleware, such as auth or metrics. It fits any stack. */
type Middleware = <TBase>(
  next: MiddlewareFetch<TBase>,
) => MiddlewareFetch<TBase>;

/** Body-aware middleware, which treats every body as TBase. */
type BodyMiddleware<TBase> = (
  next: MiddlewareFetch<TBase>,
) => MiddlewareFetch<TBase>;

function composeMiddleware<TBase>(
  middleware: BodyMiddleware<TBase>[],
  next: MiddlewareFetch<TBase>,
): MiddlewareFetch<TBase>;

const logging: Middleware = (next) => async (url, init) => {
  console.log("request", url);
  const result = await next(url, init);
  console.log("result", result);
  return result;
};
```

`composeMiddleware` only composes functions. It applies each middleware to the one after it, and the `next` argument becomes the innermost step. It has no options and does no error handling, so a single `reduceRight` over the list is enough.

Each middleware's outer function runs once, when the chain is composed. The inner function runs on every request. Setup that should happen once, such as creating a cache, belongs in the outer function.

Semantics:

- **Order:** `middleware[0]` is the outermost layer. Requests travel from `middleware[0]` toward `next`. Results travel back in reverse order, so any change an inner middleware makes to the response is visible to the middleware outside it. This includes transforms applied to a streaming response.
- **Classified results:** the innermost step is `nonThrowingFetch`, so every result a middleware receives has already been classified. For example, an auth middleware can check `result instanceof ApiError && result.status === 401`.
- **`init` is always present in middleware.** `MiddlewareFetch` is built from `NonThrowingFetch` with `Required<Parameters<…>>`, so it has the same parameters with `init` required, and any parameter added to `NonThrowingFetch` later carries over automatically. Callers can still leave `init` out, because `createFetch` returns a `NonThrowingFetch` and defaults a missing `init` to `{}`. `nonThrowingFetch` fits where a `MiddlewareFetch` is expected, so it can be the innermost step with no cast.
- **Request changes:** middleware can pass a different url or init to `next`, and must always pass an init. Middleware receives the caller's url as given, which is a `string` or a `URL`, and the caller's own init object when there is one. Don't mutate `init` directly, because that changes the caller's object. Spread it into a new object instead. `init.headers` can be a plain object, an array of pairs, or a `Headers` instance, so middleware that changes headers should copy them first with `new Headers(init.headers)`.

  ```ts
  const auth: Middleware = (next) => (url, init) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", "Bearer token");
    return next(url, { ...init, headers });
  };
  ```

- **Short-circuiting:** middleware can return a result without calling `next`, for example to serve a cached response.
- **Retrying:** middleware can call `next` more than once with the same url and init. This works for string and other reusable bodies, but not for a `ReadableStream` body, which can be read only once.
- **Exceptions:** `composeMiddleware` doesn't catch exceptions. When a middleware throws, the `next` call in the middleware outside it rejects. `createFetch` catches whatever reaches the top.

### Body-agnostic and body-aware middleware

Middleware is shared by every call made through a fetch, and each call can choose a different body type, so middleware never sees a call's exact body type. It sees the stack's **base type** instead.

- **`Middleware` is body-agnostic.** It's a generic function type, so `const auth: Middleware = (next) => async (url, init) => …` fits any stack. Inside it, `json()` resolves to the base type, which it can pass along but not inspect. Most middleware is like this: auth, headers, metrics, and logging.
- **`BodyMiddleware<TBase>` is body-aware.** It treats every body as `TBase`, so it can read and change values. A middleware that edits JSON, adds stream values, or returns a response it built itself has to be body-aware.

  ```ts
  type GraphqlMiddleware = BodyMiddleware<GraphqlResponse>;

  const graphqlErrors: GraphqlMiddleware = (next) => async (url, init) => {
    const result = await next(url, init);
    if (isUnaryResponse(result)) {
      const body = await result.json(); // GraphqlResponse
      // ...
    }
    return result;
  };
  ```

- **`createFetch` infers the base type from its middleware.** With only body-agnostic middleware, the base type is `unknown`. Body-aware middleware narrows it, and each call can then refine it further: `graphqlFetch<GraphqlResponse<{ me: User }>>("/graphql")`. A call type that doesn't fit the base type, such as `graphqlFetch<User[]>`, is a type error, and so is body-aware middleware in a stack with a different base type.
- **The base type describes every request through that fetch.** A GraphQL stack assumes every body is a GraphQL response, so GraphQL and REST requests should use separate fetches.

## createFetch

```ts
interface CreateFetchOptions<TBase = unknown> {
  /** Consumer middleware. It runs inside the default middleware. */
  middleware?: BodyMiddleware<TBase>[];
  // Plus the options that configure the default middleware (see "Default middleware").
}

function createFetch<TBase = unknown>(
  options?: CreateFetchOptions<TBase>,
): NonThrowingFetch<TBase>;
```

`createFetch` never takes the body type itself. It infers `TBase` from the middleware, and each call chooses its own body type (see "Body types").

`createFetch` creates a non-throwing fetch by composing middleware around the base fetch:

1. It builds the default middleware from `options`.
2. It composes the default middleware, followed by `options.middleware`, around `nonThrowingFetch`.
3. It returns a `NonThrowingFetch`. That function defaults a missing `init` to `{}`, passes the url and init through the composed chain, and resolves to an `Error` if a middleware throws.

The chain runs at the base type, and `createFetch` casts the result to each call's body type. This is where the per-call type is asserted.

```ts
const fetch = createFetch({ middleware: [auth] });

const result = await fetch<User[]>("/api/users");
```

### Default middleware

Default middleware ships with the library, and `createFetch` installs it in every fetch it creates. Each default is configured through `CreateFetchOptions`, so consumers change common behavior by passing options instead of writing middleware.

- Default middleware runs outside consumer middleware. A request passes through the defaults first, and a result reaches consumer middleware before it reaches the defaults.
- Which defaults ship first is still open (see "Open questions"). Until that's decided, the set of defaults is empty.

## ReReadableResponse

A native `Response` body can be read only once. `ReReadableResponse` extends `Response` so that several middleware, and finally the caller, can each read the body. Middleware can also change the parsed value that the layers after it will see.

- `ReReadableResponse` is a subclass of `Response`. It passes `instanceof Response` and keeps `status`, `statusText`, `headers`, `url`, and the other standard properties.
- A response is either **unary** or **streaming**, depending on its `Content-Type` (see "Streaming responses"). The same class handles both. Unary bodies are read with `json()` and `text()`, and streaming bodies with `iterable()`.
- `clone()` returns a `ReReadableResponse` that has the same cached state. The copy reads its body through the original response, so the body is still read only once, and the copy shares the original's stream. `clone()` works before or after the body has been read, unlike native `Response.clone()`, which throws once the body has been used.

### Unary bodies

- `json()` and `text()` can each be called any number of times. Every call returns the same value.
- The underlying body is read only once, as text, and that text is cached. `json()` parses from the cached text, so calling `json()` and then `text()` must work.
- `arrayBuffer()`, `blob()`, and `formData()` are out of scope for the initial build and are not wrapped.
- The parsed value of each method is cached after its first call. Later calls return the cached value without parsing again.
- **Mutation happens in place.** Every `json()` call returns the same object reference, so a middleware changes the response by mutating that object directly:

  ```ts
  const data = await response.json();
  data.key = value; // the outer middleware and the caller see this change
  ```

- Text can be changed too. Strings can't be mutated in place, so a middleware replaces the text with `setText(value)`, and every later `text()` call returns `value`.
- `json()` and `text()` keep separate caches. A change to one doesn't change the other.

## Streaming responses

The data layer supports streaming responses over **SSE** and **multipart**, and keeps full control over the stream. Every middleware sees every value, can change values, and can change the flow of values: drop, add, delay, or end early. Async iterables are the primary API.

```ts
const middleware: Middleware = (next) => async (url, init) => {
  const result = await next(url, init);
  if (isUnaryResponse(result)) {
    const data = await result.json();
    // ...
  } else if (isStreamingResponse(result)) {
    result.iterable().transform(async function* (source) {
      for await (const value of source) {
        // ...
        yield value;
      }
    });
  }
  return result;
};

// The caller reads the stream once.
const result = await fetch("/api/prices");
if (isStreamingResponse(result)) {
  for await (const value of result.iterable()) {
    if (value instanceof Error) break; // NetworkError or Error, always the last value
    render(value);
  }
}
```

Middleware works with a stream in two ways, and neither one iterates it:

- **`observe`, to watch values.** Logging, metrics, and other code that only reads values should use it.
- **`transform`, to change values.** Use it to edit, add, drop, or delay values, or to end the stream early.

A stream can be read only once, and that read belongs to the consumer. If a middleware iterates the stream itself, the consumer gets an `Error` instead of values. Iterating would also be the wrong tool anyway: a loop that's awaited before returning holds the response back until the stream ends, so everything outside it gets every value at once instead of as each one arrives.

A middleware that logs each value looks like this:

```ts
const logStream: Middleware = (next) => async (url, init) => {
  const result = await next(url, init);
  if (isStreamingResponse(result)) {
    result.iterable().observe({
      value: (value) => console.log("stream value", value),
      end: () => console.log("stream ended"),
    });
  }
  return result;
};
```

### Detecting a stream

```ts
function isStreamingResponse(result: FetchResult): result is StreamingResponse;
function isUnaryResponse(result: FetchResult): result is UnaryResponse;
```

These are standalone functions, not methods. Each one takes any `FetchResult` and returns `false` for error results, so it can be called directly on the result of `next` or `fetch`.

`StreamingResponse` and `UnaryResponse` are `ReReadableResponse` with a type-only brand. Without the brand, a `false` result would tell TypeScript that the value can't be a `ReReadableResponse` at all, which isn't true. With the brand, a `false` from `isStreamingResponse` still leaves `ReReadableResponse` possible in the other branch.

A response's kind is decided by its `Content-Type`:

| Content-Type              | Kind      | Protocol  |
| ------------------------- | --------- | --------- |
| `text/event-stream`       | streaming | SSE       |
| `multipart/mixed`         | streaming | multipart |
| anything else, or missing | unary     | none      |

### `iterable()`

```ts
type StreamValue<T> = T | NetworkError | Error;

class ReReadableResponse<TBody = unknown> extends Response {
  json(): Promise<TBody>;
  iterable(): ReReadableAsyncIterable<TBody>;
}
```

Neither method takes a type argument. The body type comes from the response's type, which comes from the fetch call (see "Body types").

- `iterable()` is synchronous, and every call returns the **same** `ReReadableAsyncIterable`. Middleware calls it to add a stage with `transform` or `observe`. The consumer, meaning the application code that called `fetch`, calls it to read the stream.
- **All validation happens in `ReReadableResponse`.** `iterable()` reads the protocol from `Content-Type`. For multipart, it also reads the `boundary` parameter, which may be quoted, and passes it to the parser. The parsers assume their input is valid.
- **If validation fails, `iterable()` throws a `TypeError`.** This works like `json()`, which rejects when it can't read the body. Validation fails when the response isn't streaming, when a multipart `Content-Type` has no boundary, when the body was already read as text, or when there's no body. A failure isn't cached, so every call throws until the problem is fixed.
- In middleware, a throw from `iterable()` passes up the chain like any other middleware exception, and `createFetch` resolves it to an `Error`. A consumer who calls `iterable()` directly, outside the fetch, has to catch the error themselves. Use `isStreamingResponse` first to rule out most of these failures.
- The body is read either as text, by `json()` or `text()`, or as a stream, by `iterable()`, whichever is called first. Calling the other kind afterwards fails: `json()` and `text()` reject, and `iterable()` throws.
- Once a stream has started, errors are still never thrown. They are yielded as the last value (see "Stream values").
- Nothing is read from the body until someone starts iterating.

### Stream values

Both protocols yield **parsed JSON payloads**:

- **SSE:** each event's `data` field is joined across multiple `data:` lines with `\n`, then `JSON.parse`d. Comments are skipped, and so are events whose data is missing or only whitespace, such as keep-alives. An event the stream ends before completing is dropped. The event name, `id`, and `retry` fields are dropped. Line endings can be `\r\n`, `\n`, or `\r`.
- **Multipart:** the body is split on the `--boundary` delimiter. Each part's headers are skipped, and its body is `JSON.parse`d. Parts with an empty body are skipped. The stream ends at the closing `--boundary--` delimiter, and the rest of the body is cancelled. Any preamble before the first delimiter and any epilogue after the last are ignored. Lines end in `\r\n`, as RFC 2046 requires. Transport padding after a delimiter is ignored.

Both parsers decode UTF-8 as a stream. They must handle chunk boundaries anywhere, including in the middle of a delimiter or a multi-byte character.

**Errors end the stream.** An error is never thrown. Instead it is yielded as the last value, and then iteration ends:

- If reading the body fails, for example because the connection drops or the request is aborted, the stream yields a `NetworkError` whose `cause` is the read error.
- If a payload fails to parse, the stream yields an `Error` whose `cause` is the `SyntaxError`.

### Parsers

```ts
function parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown>;
function parseMultipart(
  stream: ReadableStream<Uint8Array>,
  boundary: string,
): AsyncGenerator<unknown>;
```

Each parser is an `async function*` that reads the stream with `stream.getReader()`, buffers decoded text, and yields each payload as soon as it is complete. If iteration stops before the stream ends, the parser cancels the reader in a `finally` block. This cancels the underlying response body.

## ReReadableAsyncIterable

```ts
class ReReadableAsyncIterable<T> implements AsyncIterable<StreamValue<T>> {
  constructor(source: AsyncIterable<StreamValue<T>>);
  [Symbol.asyncIterator](): AsyncIterator<StreamValue<T>>; // the one read
  transform(
    fn: (
      source: AsyncIterable<StreamValue<T>>,
    ) => AsyncIterable<StreamValue<T>>,
  ): void;
  observe(observer: StreamObserver<T>): void;
}

interface StreamObserver<T> {
  value?(value: StreamValue<T>): void; // each value, including an error that ends the stream
  end?(): void; // the stream reached its end; not called when the reader stops early
}
```

`T` is the payload type. Every read yields `StreamValue<T>`, so the error that can end a stream is always part of the type.

`ReReadableAsyncIterable` is a stream that middleware builds up and the consumer reads once. It keeps a single source, which is never `undefined`:

```ts
class ReReadableAsyncIterable<T> {
  #source: AsyncIterable<T>;
  #consumed = false; // set once the read starts

  [Symbol.asyncIterator]() {
    if (this.#consumed) return yieldError(alreadyRead);
    this.#consumed = true;
    return this.#source[Symbol.asyncIterator]();
  }

  transform(fn) {
    if (!this.#consumed) this.#source = endOnError(fn(this.#source));
  }

  observe(observer) {
    this.transform(async function* (source) {
      for await (const value of source) {
        observer.value?.(value); // errors from the observer are ignored
        yield value;
      }
      observer.end?.();
    });
  }
}
```

### The pipeline

`transform` and `observe` don't read the stream. Each one adds a stage in front of the reader. With three middleware, the stages chain like this:

```ts
result.iterable().transform(fnA); // inner middleware runs first on the way out
result.iterable().observe(metrics); // middle
result.iterable().transform(fnB); // outer
for await (const value of result.iterable()) { … } // the consumer's read
```

```
bytes → parser → fnA → metrics observer → fnB → consumer
```

- **Every stage sees every value, in order, from the first to the last.** The stream is pull-based. When the consumer asks for a value, `fnB` asks the observer, the observer asks `fnA`, and `fnA` asks the parser. Each value passes through every stage once.
- **No value is missed.** Each middleware adds its stage while `next()` is returning, and the consumer only starts reading after `fetch` resolves, so every stage is in place before the first value arrives.
- **Order matches the onion.** Inner middleware adds its stage first, so it sits closer to the parser, and outer middleware sees its changes.
- **Stopping early cancels the request.** When the consumer breaks out of its loop, the stop travels back through every stage to the parser, which cancels the response body.
- **Values are passed by reference.** Like `json()`, a stage that mutates a value in place changes what every later stage and the consumer see.

### Reading a stream

- **The stream is read once.** The read starts when someone iterates `iterable()`. Any later read yields one `Error` and ends without touching the source. That holds even while the first read is still in progress, so a later read can't take values from it. The error message says to use `transform()` or `observe()` instead of iterating. A `transform` or `observe` added after the read has started has no effect.
- **Middleware never iterates the stream.** It changes values with `transform`, and watches them with `observe`.
- **A middleware that iterates the stream anyway** takes the one read, and the consumer gets the `Error`. This shows up immediately in development.
- **A response that's never iterated is never read.** Its body stays unread until the response is garbage-collected. To stop the request sooner, abort it through the `AbortSignal` in `init`.

Semantics of `transform` and `observe`:

- **Transforms receive errors too.** The last value can be a `NetworkError` or `Error`, so a transform should pass error values through unchanged.
- **A transform that throws ends the stream.** The reader gets an `Error` whose `cause` is the thrown value, as the last value.
- **`transform` keeps the value type.** It maps `T` to `T`, because it changes the iterable in place and can't change its static type.
- **`observe` watches without changing anything.** It's a transform that yields every value unchanged and calls the observer along the way. It sees values as transformed by stages added before it, but not by stages added after it.
- **Observers can't break the stream.** Errors thrown by an observer are caught and ignored, whereas a transform that throws would end the stream with an `Error`.
- **Stages run at the reader's pace.** Each stage runs when the reader pulls that value. Timings measured in an observer are therefore when the value reached the reader, not when it came off the network.

## Initial build scope

**In scope:**

- Unary request/response with JSON and text bodies.
- Streaming responses over SSE (`text/event-stream`) and multipart (`multipart/mixed`), with JSON payloads.

**Out of scope for now:**

- Binary and form bodies (`arrayBuffer`, `blob`, `formData`).
- Streaming request bodies.
- Non-JSON stream payloads, and other streaming formats such as NDJSON.
- SSE reconnection (`Last-Event-ID`, `retry`).
- Upload/download progress.
- Built-in retry or caching middleware.
- Request deduplication.

**Tooling:**

- TypeScript in strict mode.
- No runtime dependencies.
- Targets modern browsers and Node 18+, which have native `fetch`.
- Vitest for tests.

### Tests (definition of done)

Tests replace `globalThis.fetch` with a mock, using `vi.stubGlobal`, and never touch the real network. Streaming tests build response bodies from a `ReadableStream` that they control, so they can choose where chunks split and when each chunk arrives. The suite must show the following.

**`nonThrowingFetch`:**

- A 2xx response resolves to a `ReReadableResponse`.
- 4xx and 5xx responses resolve to an `ApiError` with the correct `status`, and the error body is readable through `error.response`.
- A rejected native fetch resolves to a `NetworkError` with `status === -1` and the original `cause`.
- An aborted or timed-out request resolves to a `NetworkError`.
- An invalid request resolves to an `Error`, not a `NetworkError`.

**Middleware composition:**

- Each middleware's outer function is called once, when the chain is composed, not on every request.
- Middleware runs in the documented order, on the way in and on the way out.
- Every middleware can read the response body, and so can the final caller.
- When an inner middleware mutates the JSON object in place, the outer middleware and the caller see the change.
- When an inner middleware replaces the text with `setText`, the outer middleware and the caller see the change.
- Middleware can change the url and the init before calling `next`.
- Middleware can short-circuit without calling `next`.
- Middleware can retry, including a request that has a body.
- When an inner middleware transforms a stream, the outer middleware and the caller see the transformed values, including dropped values, added values, and an early end.
- A middleware that transforms a stream returns the response before the stream ends, so the caller receives the first value while later values are still pending.

**createFetch:**

- With no options, it behaves like `nonThrowingFetch`.
- Middleware receives the caller's url and init, and `{}` when the caller leaves `init` out.
- `init` is optional in the fetch that `createFetch` returns and required in `MiddlewareFetch`. These are type-level checks.
- Passing a `Request` object is a type error.
- Consumer middleware runs inside the default middleware.
- A middleware that throws resolves to an `Error` whose `cause` is the thrown value. The fetch never rejects.

**Body types** (type-level checks in `src/body-types.test.ts`):

- Each call chooses its body type, and `json()` and `iterable()` are typed from it. With no type argument, the body type is the base type.
- `isStreamingResponse` and `isUnaryResponse` keep the body type when they narrow.
- `createFetch` infers the base type from body-aware middleware, and each call can refine it.
- A call type that doesn't fit the base type is rejected, and so is body-aware middleware in a stack with a different base type.
- Body-agnostic `Middleware` fits any stack.
- `ApiError` bodies stay `unknown`.

**ReReadableResponse:**

- Repeated calls to `json()` and `text()` return equal values, in any order.
- The underlying body is read exactly once.
- `clone()` keeps the cached and mutated state.
- `isStreamingResponse` and `isUnaryResponse` classify responses by `Content-Type`, and return `false` for error results.
- `iterable()` returns the same instance on every call.
- `iterable()` throws a `TypeError` for a unary response, for multipart with no boundary, and for a response with no body. A failure isn't cached.
- After `iterable()`, `json()` and `text()` reject. After `text()`, `iterable()` throws.
- When a middleware's `iterable()` call throws, `createFetch` resolves to an `Error`.

**Parsers:**

- SSE and multipart payloads are parsed correctly when chunks split anywhere, including in the middle of a delimiter or a multi-byte character.
- SSE: multi-line `data` is joined. Comments and events with no `data` are skipped. All three line endings work.
- Multipart: a quoted boundary works. Preamble, epilogue, and part headers are ignored. The stream ends at the closing delimiter.
- A payload that isn't valid JSON yields an `Error`, then the stream ends.
- A body that fails partway through, or is aborted, yields a `NetworkError`, then the stream ends.

**ReReadableAsyncIterable:**

- The read takes the source directly, with nothing in between.
- Every read after the first yields one `Error`, even one that starts while the first read is still in progress, and it doesn't take values from the first read.
- A `transform` or `observe` added after the read starts has no effect.
- Every stage sees every value, in order, and inner stages sit closer to the source.
- The source is read once, and each stage runs once per value.
- Values are pulled only as the reader asks for them.
- Stopping early closes the source, with or without stages in front of it.
- `observe` sees every value, including a final error, and leaves the stream unchanged.
- `observe` calls `end` when the stream ends, but not when the reader stops early.
- Errors thrown by an observer are ignored.
- A middleware that observes the stream doesn't take values from the caller.
- A middleware that iterates the stream itself leaves the caller with an `Error`.

## Open questions

- **Default middleware:** which defaults ship in the first build, and which options configure them? Possible candidates are a base URL, default headers, and a timeout.
- **Dropped SSE fields:** parsed JSON payloads drop the SSE event name and `id`. Revisit this if we need event-name routing or reconnection with `Last-Event-ID`.

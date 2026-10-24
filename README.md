# Data Layer

A frontend TypeScript networking library built on the native `fetch`. Its fetch never throws: every request resolves to either a `ReReadableResponse` or an error object. You extend it with a middleware stack. See [DIRECTIONS.md](DIRECTIONS.md) for the full spec.

## Usage

```ts
import { ApiError, NetworkError, createFetch, type Middleware } from './src';

const auth: Middleware = (next) => (url, init) => {
  const headers = new Headers(init.headers);
  headers.set('authorization', 'Bearer token');
  return next(url, { ...init, headers });
};

const fetch = createFetch({ middleware: [auth] });

// The body type is chosen per call.
const result = await fetch<User[]>('https://api.example.com/users');
if (result instanceof ApiError) console.error('Server error', result.status, await result.response.json());
else if (result instanceof NetworkError) console.error('No response', result.cause);
else if (result instanceof Error) console.error('Unexpected error', result.cause);
else console.log(await result.json()); // User[]
```

### Body types

Each call chooses its body type, as in `fetch<User[]>(…)`, and `json()` and `iterable()` are typed from it. The type is an assertion, so nothing checks the body's shape at runtime.

Most middleware is body-agnostic and is typed with `Middleware`, like `auth` above, so it fits any fetch. Middleware that needs to read or change body values is typed with `BodyMiddleware`. `createFetch` infers the fetch's base type from it, and every call's type must fit that base:

```ts
type GraphqlMiddleware = BodyMiddleware<GraphqlResponse>;

const graphqlErrors: GraphqlMiddleware = (next) => async (url, init) => {
  const result = await next(url, init);
  if (isUnaryResponse(result)) {
    const body = await result.json(); // GraphqlResponse
    if (body.errors?.length) console.warn(body.errors);
  }
  return result;
};

const graphqlFetch = createFetch({ middleware: [auth, graphqlErrors] });
await graphqlFetch<GraphqlResponse<{ me: User }>>('/graphql', { method: 'POST', body });
```

### Streaming responses

SSE (`text/event-stream`) and multipart (`multipart/mixed`) responses are read with `iterable()`, which yields each payload as parsed JSON. Like `json()`, `iterable()` throws a `TypeError` if the body can't be read as a stream, for example a multipart response with no boundary. Once the stream is running, errors are never thrown: a `NetworkError` or `Error` is yielded as the last value instead.

```ts
import { createFetch, isStreamingResponse, type BodyMiddleware } from './src';

interface Price {
  symbol: string;
  price: number;
  receivedAt?: number;
}

// Middleware changes values with transform(), or only watches them with observe(). It never
// iterates the stream: a stream is read once, by the consumer. Changing values needs to know
// their type, so this middleware is body-aware.
const addReceivedAt: BodyMiddleware<Price> = (next) => async (url, init) => {
  const result = await next(url, init);
  if (isStreamingResponse(result)) {
    result.iterable().transform(async function* (source) {
      for await (const value of source) {
        yield value instanceof Error ? value : { ...value, receivedAt: Date.now() };
      }
    });
  }
  return result;
};

const fetchPrices = createFetch({ middleware: [addReceivedAt] }); // base type: Price
const result = await fetchPrices('https://api.example.com/prices');
if (isStreamingResponse(result)) {
  for await (const value of result.iterable()) {
    if (value instanceof Error) break; // NetworkError or Error, always the last value
    console.log(value.symbol, value.price, value.receivedAt);
  }
}
```

## Project layout

| Path | Contents |
| --- | --- |
| `src/non-throwing-fetch.ts` | `nonThrowingFetch`, the base fetch that decides between a response and an error, and the `FetchResult` and `NonThrowingFetch` types |
| `src/compose-middleware.ts` | `composeMiddleware` and the `Middleware`, `BodyMiddleware`, and `MiddlewareFetch` types |
| `src/create-fetch.ts` | `createFetch`, which composes middleware around `nonThrowingFetch` |
| `src/errors.ts` | `ApiError` and `NetworkError` |
| `src/re-readable-response.ts` | `ReReadableResponse`, including `iterable()` for streaming responses |
| `src/response-kind.ts` | `isStreamingResponse` and `isUnaryResponse` |
| `src/stream-protocol.ts` | Reads the streaming protocol and multipart boundary from a `Content-Type` |
| `src/re-readable-async-iterable.ts` | `ReReadableAsyncIterable`, a stream read once, with `transform` and `observe` stages |
| `src/parse-sse.ts` | `parseSse`, the SSE parser |
| `src/parse-multipart.ts` | `parseMultipart`, the multipart parser |
| `src/decode-text.ts` | Decodes a byte stream as UTF-8 text for the parsers |
| `src/middlewares/` | Ready-made middleware: `addHeaders` and `captureMetrics` |
| `src/index.ts` | Public exports |
| `src/*.test.ts` | Tests |
| `src/test-helpers.ts` | Mock `fetch` and stream helpers shared by the tests |

## Running the tests

### Requirements

- Node.js 18 or later, which has native `fetch`, `Request`, and `Response`.
- [pnpm](https://pnpm.io).

### Setup

Install the dev dependencies (TypeScript and Vitest):

```sh
pnpm install
```

### Commands

| Command | What it does |
| --- | --- |
| `pnpm test` | Runs the whole test suite once. |
| `pnpm vitest` | Runs the tests in watch mode and re-runs them when files change. |
| `pnpm vitest src/re-readable-response.test.ts` | Runs a single test file. |
| `pnpm vitest -t "ApiError"` | Runs only the tests whose name matches the pattern. |
| `pnpm typecheck` | Type-checks the source and the tests with `tsc`. Vitest doesn't check types, so run this too. |

Before committing, run both:

```sh
pnpm typecheck && pnpm test
```

### How the tests work

The tests never touch the real network. They replace `globalThis.fetch` with a mock using the `stubFetch` helper from `src/test-helpers.ts`, which calls Vitest's `vi.stubGlobal`. Each test file restores the real fetch after every test with `vi.unstubAllGlobals()`.

```ts
stubFetch(() => Response.json({ name: 'Ada' }));

const fetch = createFetch({ middleware });
const result = await fetch('https://api.test/users');
```

Streaming tests build bodies with `streamOf` (fixed chunks) or `controlledStream` (the test pushes chunks, closes, or errors the stream). Parser tests use `chunkings` to check every place a body can split, including in the middle of a multi-byte character.

The test files:

- **`src/non-throwing-fetch.test.ts`** covers how `nonThrowingFetch` classifies results: success, `ApiError`, `NetworkError` (including aborts and timeouts), and `Error` for invalid requests.
- **`src/compose-middleware.test.ts`** covers middleware: the order it runs in, reading and mutating the response, changing the request, short-circuiting, retrying, and exceptions passing up the chain.
- **`src/create-fetch.test.ts`** covers `createFetch`: running the middleware it's given and resolving middleware exceptions to an `Error`.
- **`src/re-readable-response.test.ts`** covers unary `ReReadableResponse` bodies: repeated reads, reading the body only once, in-place JSON mutation, `setText`, and `clone()`.
- **`src/streaming-response.test.ts`** covers `isStreamingResponse`, `isUnaryResponse`, and `iterable()`: validation, stream errors, cancellation, and mixing text and stream reads.
- **`src/streaming-middleware.test.ts`** covers middleware with streams: transforms and observers seen by outer layers, values arriving while the stream is open, cancellation, and a middleware that iterates the stream itself.
- **`src/re-readable-async-iterable.test.ts`** covers `ReReadableAsyncIterable`: the single read, the pipeline of stages, `transform`, `observe`, and closing the source.
- **`src/parse-sse.test.ts`** and **`src/parse-multipart.test.ts`** cover the parsers.
- **`src/body-types.test.ts`** holds type-level checks for body typing, which `pnpm typecheck` verifies: per-call body types, base types inferred from body-aware middleware, and mismatches that must fail.
- **`src/middlewares/capture-metrics.test.ts`** covers `captureMetrics`: request counts, timing and size metrics for unary and streaming responses, and not delaying the caller.
- **`src/middlewares/add-headers.test.ts`** covers `addHeaders`: adding and overriding headers without changing the caller's `init`.

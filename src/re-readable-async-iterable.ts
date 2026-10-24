import { NetworkError, toError } from "./errors";

/** A value from a stream. An error is always the last value. */
export type StreamValue<T> = T | NetworkError | Error;

/** Watches a stream's values without changing them. See `observe()`. */
export interface StreamObserver<T> {
  /** Called with each value, including an error that ends the stream. */
  value?(value: StreamValue<T>): void;
  /** Called when the stream reaches its end. Not called when the reader stops early. */
  end?(): void;
}

const CONSUMED_MESSAGE =
  "The stream was already read. A stream can be read once, so middleware should use transform() or observe() instead of iterating it.";

/**
 * A stream that middleware builds up and the consumer reads once.
 *
 * `transform()` and `observe()` add stages in front of the reader, so every
 * stage sees every value, in order, from the first to the last. Nothing is
 * buffered, and a reader that stops early cancels the request. A second read
 * yields an Error.
 */
export class ReReadableAsyncIterable<T> implements AsyncIterable<
  StreamValue<T>
> {
  #source: AsyncIterable<StreamValue<T>>;
  // Set once the read starts. Later reads yield an Error and never touch the
  // source, so they can't take values from the reader.
  #consumed = false;

  constructor(source: AsyncIterable<StreamValue<T>>) {
    this.#source = source;
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamValue<T>> {
    if (this.#consumed) return yieldError(new Error(CONSUMED_MESSAGE));
    this.#consumed = true;
    return this.#source[Symbol.asyncIterator]();
  }

  /**
   * Adds a stage that can change values. `fn` becomes the only consumer of the
   * current source, so no tee is needed. It should iterate `source` at most once.
   */
  transform(
    fn: (
      source: AsyncIterable<StreamValue<T>>,
    ) => AsyncIterable<StreamValue<T>>,
  ): void {
    if (!this.#consumed) this.#source = endOnError(fn(this.#source));
  }

  /**
   * Watches each value as the reader pulls it, without changing the stream. It's
   * a transform that yields every value unchanged, so it adds no reader and no
   * buffering, and an early stop still cancels the request. Errors thrown by the
   * observer are ignored, so observing can never break the stream.
   */
  observe(observer: StreamObserver<T>): void {
    this.transform(async function* (source) {
      for await (const value of source) {
        ignoreErrors(() => observer.value?.(value));
        yield value;
      }
      ignoreErrors(() => observer.end?.());
    });
  }
}

function ignoreErrors(fn: () => void): void {
  try {
    fn();
  } catch {
    // Observers can't affect the stream, even by throwing.
  }
}

/** Yields everything from `source`, but turns a thrown error into a last value. */
export async function* endOnError<T>(
  source: AsyncIterable<T>,
): AsyncGenerator<StreamValue<T>> {
  try {
    yield* source;
  } catch (error) {
    yield error instanceof NetworkError ? error : toError(error);
  }
}

export async function* yieldError(error: Error): AsyncGenerator<Error> {
  yield error;
}

import { describe, expect, it, vi } from 'vitest';
import { endOnError, ReReadableAsyncIterable, type StreamValue } from './re-readable-async-iterable';
import { collect, flush } from './test-helpers';

async function* count(n: number, log: string[] = []) {
  try {
    for (let i = 1; i <= n; i++) {
      log.push(`produce ${i}`);
      yield i;
    }
  } finally {
    log.push('closed');
  }
}

/** A source the test pushes values into, one at a time. */
const pushable = <T>() => {
  const values: T[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  async function* source(): AsyncGenerator<T> {
    while (true) {
      if (values.length) yield values.shift()!;
      else if (ended) return;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return {
    source: source(),
    push: (value: T) => {
      values.push(value);
      wake?.();
    },
    end: () => {
      ended = true;
      wake?.();
    },
  };
};

const double = async function* (source: AsyncIterable<StreamValue<number>>) {
  for await (const value of source) yield typeof value === 'number' ? value * 2 : value;
};

describe('ReReadableAsyncIterable', () => {
  describe('reading', () => {
    it('reads the source directly, with nothing in between', () => {
      const source = count(3);
      const iterable = new ReReadableAsyncIterable(source);

      expect(iterable[Symbol.asyncIterator]()).toBe(source);
    });

    it('yields one Error for every read after the first', async () => {
      const iterable = new ReReadableAsyncIterable(count(3));
      expect(await collect(iterable)).toEqual([1, 2, 3]);

      const [again] = await collect(iterable);

      expect(again).toBeInstanceOf(Error);
      expect((again as Error).message).toMatch(/transform\(\) or observe\(\)/);
    });

    it('does not let a read that starts mid-stream take values from the reader', async () => {
      const { source, push, end } = pushable<number>();
      const iterable = new ReReadableAsyncIterable(source);
      const reading = collect(iterable);
      push(1);
      await flush();

      const late = collect(iterable);
      push(2);
      push(3);
      end();

      expect(await reading).toEqual([1, 2, 3]);
      const lateValues = await late;
      expect(lateValues).toHaveLength(1);
      expect(lateValues[0]).toBeInstanceOf(Error);
    });

    it('ignores a transform applied after the read starts', async () => {
      const iterable = new ReReadableAsyncIterable(count(2));
      const values = collect(iterable);

      iterable.transform(double);

      expect(await values).toEqual([1, 2]);
    });

    it('closes the source when the reader stops early', async () => {
      const log: string[] = [];
      const iterable = new ReReadableAsyncIterable(count(5, log));

      for await (const value of iterable) if (value === 1) break;

      expect(log).toEqual(['produce 1', 'closed']);
    });
  });

  describe('pipeline', () => {
    it('gives every stage every value, in order, from the first to the last', async () => {
      const seen: Record<string, unknown[]> = { inner: [], middle: [], outer: [] };
      const iterable = new ReReadableAsyncIterable(count(3));

      // Inner middleware adds its stage first, so it sits closest to the source.
      iterable.observe({ value: (value) => seen.inner!.push(value) });
      iterable.transform(double);
      iterable.observe({ value: (value) => seen.middle!.push(value) });
      iterable.transform(double);
      iterable.observe({ value: (value) => seen.outer!.push(value) });

      expect(await collect(iterable)).toEqual([4, 8, 12]);
      expect(seen).toEqual({ inner: [1, 2, 3], middle: [2, 4, 6], outer: [4, 8, 12] });
    });

    it('reads the source once, and runs each stage once per value', async () => {
      const log: string[] = [];
      let transformed = 0;
      const iterable = new ReReadableAsyncIterable(count(2, log));
      iterable.transform(async function* (source) {
        for await (const value of source) {
          transformed++;
          yield value;
        }
      });
      iterable.observe({});

      await collect(iterable);

      expect(log).toEqual(['produce 1', 'produce 2', 'closed']);
      expect(transformed).toBe(2);
    });

    it('pulls values only as the reader asks for them', async () => {
      const log: string[] = [];
      const iterable = new ReReadableAsyncIterable(count(3, log));
      iterable.transform(double);
      const reader = iterable[Symbol.asyncIterator]();

      await reader.next();

      expect(log).toEqual(['produce 1']);
    });
  });

  describe('observe', () => {
    it('sees every value, including an error, without changing the stream', async () => {
      async function* withError() {
        yield 1;
        yield 2;
        throw new Error('boom');
      }
      // ReReadableResponse wraps every source like this, so an error arrives as a value.
      const iterable = new ReReadableAsyncIterable(endOnError(withError()));
      const seen: unknown[] = [];

      iterable.observe({ value: (value) => seen.push(value) });
      const values = await collect(iterable);

      expect(values.slice(0, 2)).toEqual([1, 2]);
      expect(values[2]).toBeInstanceOf(Error);
      expect(seen).toEqual(values);
    });

    it('calls end when the stream ends, but not when the reader stops early', async () => {
      const ended = new ReReadableAsyncIterable(count(2));
      const stopped = new ReReadableAsyncIterable(count(2));
      const end = vi.fn();
      const endStopped = vi.fn();
      ended.observe({ end });
      stopped.observe({ end: endStopped });

      await collect(ended);
      for await (const value of stopped) if (value === 1) break;

      expect(end).toHaveBeenCalledTimes(1);
      expect(endStopped).not.toHaveBeenCalled();
    });

    it('ignores errors thrown by the observer', async () => {
      const iterable = new ReReadableAsyncIterable(count(3));

      iterable.observe({
        value() {
          throw new Error('observer bug');
        },
        end() {
          throw new Error('observer bug');
        },
      });

      expect(await collect(iterable)).toEqual([1, 2, 3]);
    });

    it('adds no reader, so stopping early still closes the source', async () => {
      const log: string[] = [];
      const iterable = new ReReadableAsyncIterable(count(5, log));

      iterable.observe({ value: () => {} });
      for await (const value of iterable) if (value === 1) break;

      expect(log).toEqual(['produce 1', 'closed']);
    });

    it('has no effect after the read starts', async () => {
      const iterable = new ReReadableAsyncIterable(count(2));
      const values = collect(iterable);
      const seen: unknown[] = [];

      iterable.observe({ value: (value) => seen.push(value) });

      expect(await values).toEqual([1, 2]);
      expect(seen).toEqual([]);
    });
  });

  describe('transform', () => {
    it('can change the flow of values', async () => {
      const iterable = new ReReadableAsyncIterable(count(5));
      iterable.transform(async function* (source) {
        yield 0; // added
        for await (const value of source) {
          if (value === 2) continue; // dropped
          if (value === 4) return; // ended early
          yield value;
        }
      });

      expect(await collect(iterable)).toEqual([0, 1, 3]);
    });

    it('turns a thrown error into a last value', async () => {
      const iterable = new ReReadableAsyncIterable(count(3));
      const cause = new Error('boom');
      iterable.transform(async function* (source) {
        for await (const value of source) {
          if (value === 2) throw cause;
          yield value;
        }
      });

      const values = await collect(iterable);

      expect(values).toHaveLength(2);
      expect(values[0]).toBe(1);
      expect((values[1] as Error).cause).toBe(cause);
    });
  });
});

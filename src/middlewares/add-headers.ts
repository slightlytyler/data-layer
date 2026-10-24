import type { Middleware } from "../compose-middleware";

type AddHeadersArgs = {
  headers: Request["headers"];
};

export const addHeaders =
  (args: AddHeadersArgs): Middleware =>
  (next) =>
  async (url, init) => {
    // Copy the headers and init, so the caller's own objects aren't changed.
    const headers = new Headers(init.headers);
    for (const [key, value] of args.headers) {
      headers.set(key, value);
    }
    return next(url, { ...init, headers });
  };

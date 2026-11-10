import { request } from "node:http";
import { Readable } from "node:stream";

/** HTTP over a mounted Unix socket; URL/Host retain the loopback gateway identity. */
export function socketFetch(socketPath: string): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      headers.host = url.host;
      const req = request(
        {
          socketPath,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
          headers,
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined)
              responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          resolve(
            new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
              status: res.statusCode ?? 502,
              headers: responseHeaders,
            }),
          );
        },
      );
      req.on("error", reject);
      if (typeof init?.body === "string") req.write(init.body);
      req.end();
    })) as typeof fetch;
}

import { serve } from "@hono/node-server";
import type { Env, Hono } from "hono";

export interface LoopbackServerOptions {
  port?: number;
  hostname?: string;
}

type NodeServer = ReturnType<typeof serve>;

export interface RunningLoopbackServer {
  server: NodeServer;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Bind the gateway to loopback only. `0.0.0.0` and public interfaces are never
 * accepted, so a browser on the LAN cannot reach the agent API.
 */
export async function startLoopbackServer<E extends Env>(
  app: Hono<E>,
  options: LoopbackServerOptions = {},
): Promise<RunningLoopbackServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  if (hostname !== "127.0.0.1" && hostname !== "::1") {
    throw new Error("The agent gateway may bind only to 127.0.0.1 or ::1.");
  }
  const port = options.port ?? 0;

  const server = serve({ fetch: app.fetch, hostname, port });
  await new Promise<void>((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once("listening", () => {
      resolve();
    });
    server.once("error", (error) => {
      reject(error);
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Loopback listener did not report a TCP address.");
  }

  return {
    server,
    host: address.address,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

import { timingSafeEqual } from "node:crypto";
import { createConnection, createServer } from "node:net";
import type { ServerMetadata } from "./server-metadata.js";

const pipeName = (meta: ServerMetadata): string => `\\\\.\\pipe\\devchestra-${meta.instanceId}`;

/** A token-authenticated local control pipe replaces unsupported Windows SIGTERM. */
export async function listenWindowsControl(
  meta: ServerMetadata,
  stop: () => void,
): Promise<() => Promise<void>> {
  const clients = new Set<ReturnType<typeof createConnection>>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    socket.on("error", () => undefined);
    socket.setTimeout(2000, () => socket.destroy());
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      if (input.length > 256) {
        socket.destroy();
        return;
      }
      if (!input.endsWith("\n")) return;
      const received = Buffer.from(input.trim());
      const expected = Buffer.from(meta.token);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
        socket.destroy();
        return;
      }
      socket.end("ok\n", stop);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipeName(meta), () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return async () => {
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

export async function requestWindowsStop(meta: ServerMetadata): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(pipeName(meta));
    socket.setTimeout(2000, () => socket.destroy(new Error("Windows shutdown pipe timed out")));
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${meta.token}\n`));
    let reply = "";
    socket.on("data", (chunk) => {
      reply += chunk.toString("utf8");
    });
    socket.once("end", () =>
      reply === "ok\n" ? resolve() : reject(new Error("Windows shutdown was not acknowledged")),
    );
    socket.once("close", () => {
      if (reply !== "ok\n") reject(new Error("Windows shutdown pipe closed"));
    });
  });
}

import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayPort, GatewayScope } from "@devchestra/engine";
import {
  createAgentGateway,
  ExecTokenRegistry,
  OutputValidator,
  startLoopbackServer,
} from "@devchestra/server";
import type { Store } from "@devchestra/store";

export interface RunningGateway {
  port: GatewayPort;
  close: () => Promise<void>;
}

export async function startGateway(store: Store): Promise<RunningGateway> {
  const tokens = new ExecTokenRegistry({
    registerSecret: (token) => store.security.registerSecret(token, "exec-token"),
  });
  const validator = new OutputValidator();
  let port = 0;
  const app = createAgentGateway({
    tokens,
    submissions: store.submissions,
    validator,
    port: () => port,
  });
  const server = await startLoopbackServer(app);
  port = server.port;
  const socketDir =
    process.platform === "linux" ? mkdtempSync(join(tmpdir(), "dc-gw-")) : undefined;
  const socketPath = socketDir ? join(socketDir, "gateway.sock") : undefined;
  const connections = new Set<Socket>();
  const socketServer = socketPath
    ? createServer((client) => {
        const upstream = createConnection({ host: "127.0.0.1", port });
        for (const socket of [client, upstream]) {
          connections.add(socket);
          socket.once("close", () => connections.delete(socket));
          socket.on("error", () => {
            client.destroy();
            upstream.destroy();
          });
        }
        client.pipe(upstream).pipe(client);
      })
    : undefined;
  if (socketServer && socketPath) {
    await new Promise<void>((resolve, reject) => {
      socketServer.once("error", reject);
      socketServer.listen(socketPath, resolve);
    });
    chmodSync(socketPath, 0o600);
  }
  return {
    port: {
      url: server.url,
      ...(socketPath ? { socketPath } : {}),
      issue(scope: GatewayScope) {
        const token = tokens.issue({
          identity: scope.identity,
          toolset: "agent",
          outputSchema: scope.outputSchema,
          outputSchemaHash: scope.outputSchemaHash,
          validationLimit: scope.validationLimit,
          expiresAt: scope.expiresAt,
          // Server-owned policy scope, minted per attempt; never taken from the shim.
          ...(scope.shell === undefined ? {} : { shell: scope.shell }),
        });
        return {
          token,
          drain: () => tokens.drain(token),
          revoke: (): void => {
            tokens.revoke(token);
          },
        };
      },
    },
    close: async (): Promise<void> => {
      tokens.clear();
      for (const socket of connections) socket.destroy();
      if (socketServer) await new Promise<void>((resolve) => socketServer.close(() => resolve()));
      if (socketDir) rmSync(socketDir, { recursive: true, force: true });
      await server.close();
    },
  };
}

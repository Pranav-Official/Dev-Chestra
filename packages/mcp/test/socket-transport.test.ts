import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentGatewayClient } from "../src/gateway-client.js";

describe.skipIf(process.platform === "win32")("Unix gateway transport", () => {
  it("preserves the loopback Host identity and bearer authentication", async () => {
    const root = mkdtempSync(join(tmpdir(), "dc-socket-test-"));
    const socket = join(root, "gw.sock");
    const server = createServer((req, res) => {
      expect(req.headers.host).toBe("127.0.0.1:4321");
      expect(req.headers.authorization).toBe("Bearer secret");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tools: [] }));
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const client = await createAgentGatewayClient({
        gatewayUrl: "http://127.0.0.1:4321",
        gatewaySocket: socket,
        token: "secret",
        toolset: "agent",
      });
      expect(await client.listTools()).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});

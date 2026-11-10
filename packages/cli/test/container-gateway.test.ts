import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type ContainerExecution,
  containerBaseEnv,
  detectContainerRuntime,
  runCommand,
} from "@devchestra/adapters";
import type { Path, RunId } from "@devchestra/core";
import { openStore } from "@devchestra/store";
import { describe, expect, it } from "vitest";
import { startGateway } from "../src/gateway.js";

const enabled = process.env.DEVCHESTRA_TEST_CONTAINER === "1";
describe.skipIf(!enabled)("container gateway", () => {
  it("uses the bundled stdio shim over a Unix socket and executes policy commands without agent secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "dc-gateway-live-"));
    const cwd = join(root, "clone");
    mkdirSync(cwd);
    const store = openStore({ file: join(root, "test.db") });
    const gateway = await startGateway(store);
    const shim = resolve("../mcp/dist/bin/container-shim.cjs");
    expect(existsSync(shim)).toBe(true);
    const runtime = detectContainerRuntime(root);
    const spec: ContainerExecution = {
      runtime,
      dataDir: root,
      cwd,
      runId: "test",
      executionId: "agent",
    };
    const issued = gateway.port.issue({
      identity: { runId: "test" as RunId, path: "agent" as Path, attempt: 1, generation: 1 },
      outputSchema: { type: "object" },
      outputSchemaHash: "hash",
      validationLimit: 1,
      expiresAt: Date.now() + 60_000,
      shell: {
        policy: { allow: ["env"] },
        cwd,
        env: containerBaseEnv({}),
        container: spec,
        timeoutMs: 20_000,
        maxOutputBytes: 8192,
      },
    });
    const socket = gateway.port.socketPath as string;
    const script = `const {spawn}=require('node:child_process'); const shim=spawn('node',['/run/devchestra/shim.cjs'],{stdio:['pipe','pipe','inherit']}); let text=''; const send=(m)=>shim.stdin.write(JSON.stringify(m)+'\\n'); shim.stdout.on('data',chunk=>{ text+=chunk; let i; while((i=text.indexOf('\\n'))>=0){const line=text.slice(0,i);text=text.slice(i+1);if(!line.trim())continue;const m=JSON.parse(line);if(m.id===1){send({jsonrpc:'2.0',method:'notifications/initialized'});send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'exec',arguments:{command:'env'}}});}if(m.id===2){console.log(JSON.stringify(m));shim.kill();process.exit(0);}}});send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}});`;
    try {
      const result = await runCommand(
        {
          cmd: "node",
          args: ["-e", script],
          cwd,
          env: {
            ...containerBaseEnv({}),
            GH_TOKEN: "agent-only-sentinel",
            DEVCHESTRA_EXEC_TOKEN: issued.token,
            DEVCHESTRA_GATEWAY_URL: gateway.port.url,
            DEVCHESTRA_GATEWAY_SOCKET: socket,
            DEVCHESTRA_TOOLSET: "agent",
          },
          container: {
            ...spec,
            mounts: [
              { source: dirname(socket), target: dirname(socket), readOnly: true },
              { source: shim, target: "/run/devchestra/shim.cjs", readOnly: true },
            ],
          },
          timeoutMs: 40_000,
        },
        {},
      );
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.groupStopped).toBe(true);
      expect(result.stdout).toContain("HOME=/home/devchestra");
      expect(result.stdout).not.toContain("agent-only-sentinel");
      expect(result.stdout).not.toContain(issued.token);
      expect(JSON.parse(result.stdout).result.isError).toBe(false);
    } finally {
      issued.revoke();
      await gateway.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

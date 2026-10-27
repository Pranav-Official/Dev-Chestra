import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../../dist/index.js";
import { openStore } from "../../../store/dist/index.js";
import {
  ExecTokenRegistry,
  OutputValidator,
  createAgentGateway,
  startLoopbackServer,
} from "../../../server/dist/index.js";
import { createAdapterRegistry } from "../../../adapters/dist/index.js";
import {
  acquireScratch,
  finalizeScratch,
  prepareRunWorkspace,
  releaseScratch,
} from "../../../workspaces/dist/index.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const shim = join(root, "packages/mcp/dist/bin/shim.js");
const fakeAgent = join(root, "tools/fake-agent/dist/main.js");
const base = mkdtempSync(join(tmpdir(), "relay-engine-routing-scenario-"));
const project = join(base, "project");
const dataDir = join(base, "data");
mkdirSync(project);
mkdirSync(dataDir);
const store = openStore({ file: join(dataDir, "relay.db") });
const tokens = new ExecTokenRegistry({
  registerSecret: (value, name) => store.security.registerSecret(value, name),
});
let port = 0;
const server = await startLoopbackServer(
  createAgentGateway({
    tokens,
    submissions: store.submissions,
    validator: new OutputValidator(),
    port: () => port,
    logger: (line) => process.stderr.write(line + "\n"),
  }),
);
port = server.port;
store.projects.ensure({ id: "p4", name: "P4", path: project, kind: "folder" });
const validator = new OutputValidator();

function makeEngine(script) {
  return createEngine({
    store,
    adapters: createAdapterRegistry({ fakeAgentBin: fakeAgent, fakeScript: script }),
    workspaces: {
      prepare: prepareRunWorkspace,
      acquire: acquireScratch,
      finalize: finalizeScratch,
      release: releaseScratch,
    },
    gateway: {
      url: server.url,
      issue(scope) {
        const token = tokens.issue({
          identity: scope.identity,
          toolset: "agent",
          outputSchema: scope.outputSchema,
          outputSchemaHash: scope.outputSchemaHash,
          validationLimit: scope.validationLimit,
          expiresAt: scope.expiresAt,
        });
        return { token, revoke: () => tokens.revoke(token) };
      },
    },
    dataDir,
    nodeBin: process.execPath,
    mcpShimEntry: shim,
    env: process.env,
    validateOutput: (schema, value) => validator.compile(schema).validate(value),
  });
}

function snapshot(agentScriptId, marker) {
  return {
    schemaVersion: 1,
    id: "routing-scenario",
    name: "Routing scenario",
    graph: {
      nodes: [
        {
          id: "start",
          type: "start",
          name: "Start",
          params: [{ name: "route", type: "string", required: false }],
        },
        {
          id: "gate",
          type: "gate",
          name: "Gate",
          branches: [
            { id: "A", when: 'start.route = "a"' },
            { id: "B", otherwise: true },
          ],
        },
        {
          id: "agent",
          type: "agent",
          name: "Agent",
          cli: "fake",
          prompt: "route " + agentScriptId,
          output: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
            additionalProperties: false,
          },
          permissions: { network: false, write: ["workspace"] },
          workspace: { mode: "scratch" },
          limits: { timeoutMin: 5, validationRetries: 1, crashRetries: 1 },
          context: { project: "none", workflow: "none" },
        },
        {
          id: "dead",
          type: "shell",
          name: "Dead branch",
          command: `touch '${marker}'`,
          workspace: { mode: "scratch" },
          timeoutMin: 1,
          allowFailure: false,
        },
        {
          id: "both",
          type: "join",
          name: "Join",
          mode: "all",
          inputs: ["in_a", "in_b"],
          output: {
            type: "object",
            properties: {
              in_a: {
                type: "object",
                properties: { summary: { type: "string" } },
                required: ["summary"],
                additionalProperties: false,
              },
              in_b: { type: "null" },
            },
            required: ["in_a", "in_b"],
            additionalProperties: false,
          },
        },
        {
          id: "end",
          type: "end",
          name: "End",
          status: "success",
          result: '{ "gate": gate, "join": both }',
        },
      ],
      edges: [
        { id: "e0", from: "start", to: "gate" },
        { id: "e1", from: "gate.A", to: "agent" },
        { id: "e2", from: "gate.B", to: "dead" },
        { id: "e3", from: "agent", to: "both.in_a" },
        { id: "e4", from: "dead", to: "both.in_b" },
        { id: "e5", from: "both", to: "end" },
      ],
    },
  };
}

function input(snap, params = { route: "a" }) {
  return {
    projectId: "p4",
    workflowId: "routing-scenario",
    snapshot: snap,
    snapshotRaw: JSON.stringify(snap),
    params,
  };
}

try {
  {
    const marker = join(base, "dead-branch-ran");
    const engine = makeEngine([{ type: "submit", output: { summary: "chosen" } }]);
    await engine.start();
    const result = await engine.run(input(snapshot("ok", marker)));
    if (!result.ok) throw result.error;
    assert.equal(result.value.status, "succeeded");
    assert.equal(result.value.result.gate.branch, "A");
    assert.equal(result.value.result.join.in_a.summary, "chosen");
    assert.equal(result.value.result.join.in_b, null);
    assert.equal(existsSync(marker), false, "inactive branch must not spawn a process");
    const view = store.view.get(result.value.runId);
    assert.equal(view.executions.dead.status, "skipped");
    const spawned = store.events
      .list(result.value.runId, { limit: 10_000 })
      .filter((event) => event.type === "node.process.spawned");
    assert.equal(spawned.some((event) => event.path === "dead"), false);
    await engine.stop();
  }

  {
    const marker = join(base, "dead-branch-resume");
    const snap = snapshot("resume", marker);
    const first = makeEngine([{ type: "sleep", ms: 1500 }, { type: "submit", output: { summary: "resumed" } }]);
    await first.start();
    const launched = await first.launch(input(snap));
    if (!launched.ok) throw launched.error;
    const runId = launched.value.runId;
    for (let i = 0; i < 400; i += 1) {
      const agent = store.view.get(runId).executions.agent;
      if (agent?.processSpawned !== null && agent?.processSpawned !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await first.stop();
    const stopped = store.view.get(runId);
    assert.equal(stopped.status, "paused");
    assert.equal(stopped.pauseReason, "shutdown");
    assert.equal(stopped.executions.agent.status, "interrupted");
    assert.equal(store.events.list(runId, { limit: 10_000 }).filter((e) => e.type === "gate.decided").length, 1);
    assert.equal(store.outputs.get({ runId, path: "gate", attempt: 1 }).json.branch, "A");

    const second = makeEngine([{ type: "sleep", ms: 50 }, { type: "submit", output: { summary: "resumed" } }]);
    await second.start();
    const resumed = await second.resume(runId);
    if (!resumed.ok) throw resumed.error;
    assert.equal(resumed.value.status, "succeeded");
    assert.equal(resumed.value.result.join.in_a.summary, "resumed");
    assert.equal(resumed.value.result.join.in_b, null);
    const events = store.events.list(runId, { limit: 10_000 });
    assert.equal(events.filter((e) => e.type === "gate.decided").length, 1, "gate must not be re-evaluated");
    assert.equal(events.filter((e) => e.type === "join.resolved").length, 1);
    assert.equal(existsSync(marker), false);
    await second.stop();
  }

  process.stdout.write("engine routing scenarios ok\n");
} finally {
  await server.close();
  store.close();
  rmSync(base, { recursive: true, force: true });
}

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../../../packages/store/dist/index.js";
import { ExecTokenRegistry, OutputValidator, createAgentGateway, startLoopbackServer } from "../../../packages/server/dist/index.js";
import { createAdapterRegistry } from "../../../packages/adapters/dist/index.js";
import { acquireScratch, finalizeScratch, prepareRunWorkspace, releaseScratch } from "../../../packages/workspaces/dist/index.js";
import { createEngine } from "../../../packages/engine/dist/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const shim = join(root, "packages/mcp/dist/bin/shim.js");
const fakeAgent = join(root, "tools/fake-agent/dist/main.js");
const snapshot = JSON.parse(readFileSync(join(here, "linear-research.json"), "utf8"));
const raw = JSON.stringify(snapshot);

const temp = mkdtempSync(join(tmpdir(), "devchestra-engine-smoke-"));
const store = openStore({ file: join(temp, "devchestra.db") });
const tokens = new ExecTokenRegistry({
  registerSecret: (value, name) => store.security.registerSecret(value, name),
});
let port = 0;
const submissions = {
  submit(input: Parameters<typeof store.submissions.submit>[0]) {
    try {
      return store.submissions.submit(input);
    } catch (error) {
      process.stderr.write("submit failed: " + String(error) + "\n" + (error as Error).stack + "\n");
      throw error;
    }
  },
  accepted: store.submissions.accepted,
  validationLeft: store.submissions.validationLeft,
};
const gatewayApp = createAgentGateway({
  tokens,
  submissions,
  context: store.contextPool,
  validator: new OutputValidator(),
  port: () => port,
  logger: (line) => process.stderr.write(line + "\n"),
});
const server = await startLoopbackServer(gatewayApp);
port = server.port;
const issuedTokens: string[] = [];
const projectsDir = join(temp, "project");
rmSync(projectsDir, { recursive: true, force: true });
store.projects.ensure({ id: "p1", name: "P1", path: temp, kind: "folder" });

const engine = createEngine({
  store,
  adapters: createAdapterRegistry({ fakeAgentBin: fakeAgent, fakeScript: [{ type: "submit", output: { summary: "from fake" } }] }),
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
        context: scope.context,
      });
      issuedTokens.push(token);
      return { token, revoke: () => tokens.revoke(token) };
    },
  },
  dataDir: temp,
  nodeBin: process.execPath,
  mcpShimEntry: shim,
  env: process.env,
});

try {
  await engine.start();
  const result = await engine.run({
    projectId: "p1",
    workflowId: "linear-research",
    snapshot,
    snapshotRaw: raw,
    params: { topic: "devchestra" },
  });
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
  if (!result.ok) throw result.error;
  const events = store.events.list(result.value.runId, { limit: 10_000 });
  if (result.value.status !== "succeeded") {
    process.stderr.write(JSON.stringify(events.map((e) => ({ path: e.path, type: e.type, payload: e.payload })), null, 2) + "\n");
    for (const event of events) {
      if (event.type === "node.transcript.ref") {
        process.stderr.write("TRANSCRIPT " + event.payload.file + "\n");
        process.stderr.write(readFileSync(event.payload.file, "utf8") + "\n");
      }
    }
  }
  assert.equal(result.value.status, "succeeded");
  assert.deepEqual(result.value.result, { summary: "from fake", echo: "from fake" });

  const types = new Set(events.map((event) => event.type));
  for (const type of [
    "run.created",
    "run.started",
    "node.output.recorded",
    "node.output.validated",
    "node.session.captured",
    "node.process.spawned",
    "node.workspace.finalized",
    "run.completed",
  ]) {
    assert.equal(types.has(type), true, `missing event ${type}`);
  }
  const paths = events.filter((event) => event.type === "node.state" && event.payload.to === "succeeded");
  assert.deepEqual(
    [...new Set(paths.map((event) => event.path))].sort(),
    ["end", "report", "research", "start"],
  );

  const shell = store.outputs.get({ runId: result.value.runId, path: "report", attempt: 1 });
  assert.ok(shell);
  assert.equal((shell.json as { stdout: string }).stdout, "from fake");
  assert.equal((shell.json as { exitCode: number }).exitCode, 0);
  const agent = store.submissions.accepted({ runId: result.value.runId, path: "research", attempt: 1 });
  assert.ok(agent);
  assert.deepEqual(agent.json, { summary: "from fake" });

  const transcript = events.find((event) => event.type === "node.transcript.ref");
  assert.ok(transcript);
  const transcriptText = readFileSync(transcript.payload.file, "utf8");
  assert.ok(transcriptText.length > 0);
  const allText = JSON.stringify(events) + transcriptText;
  for (const token of issuedTokens) assert.equal(allText.includes(token), false, "token leaked");

  const startOutput = store.outputs.get({ runId: result.value.runId, path: "start", attempt: 1 });
  assert.deepEqual(startOutput?.json, { topic: "devchestra" });
  assert.equal(store.view.get(result.value.runId).status, "succeeded");
  process.stdout.write(`engine smoke ok: ${result.value.runId}\n`);
} finally {
  await engine.stop();
  await server.close();
  store.close();
  rmSync(temp, { recursive: true, force: true });
}

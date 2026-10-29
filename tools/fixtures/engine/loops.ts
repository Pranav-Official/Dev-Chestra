import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapterRegistry } from "../../../packages/adapters/dist/index.js";
import { createEngine } from "../../../packages/engine/dist/index.js";
import { normalizeWorkflow, parseWorkflow, validateWorkflow } from "../../../packages/schema/dist/index.js";
import { ExecTokenRegistry, OutputValidator, createAgentGateway, startLoopbackServer } from "../../../packages/server/dist/index.js";
import { openStore } from "../../../packages/store/dist/index.js";
import { acquireScratch, finalizeScratch, prepareRunWorkspace, releaseScratch } from "../../../packages/workspaces/dist/index.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "devchestra-loop-agent-"));
const store = openStore({ file: join(temp, "store.db") });
const tokens = new ExecTokenRegistry({ registerSecret: (value, name) => store.security.registerSecret(value, name) });
const validator = new OutputValidator();
let port = 0;
const server = await startLoopbackServer(createAgentGateway({ tokens, submissions: store.submissions, validator, port: () => port }));
port = server.port;
store.projects.ensure({ id: "p", name: "Loop project", path: temp, kind: "folder" });
const engine = createEngine({
  store, dataDir: temp,
  adapters: createAdapterRegistry({ fakeAgentBin: join(root, "tools/fake-agent/dist/main.js"), fakeScript: [{ type: "submit-from-inputs", path: ["loop"], fallback: {} }] }),
  workspaces: { prepare: prepareRunWorkspace, acquire: acquireScratch, finalize: finalizeScratch, release: releaseScratch },
  gateway: { url: server.url, issue(scope) {
    const token = tokens.issue({ identity: scope.identity, toolset: "agent", outputSchema: scope.outputSchema, outputSchemaHash: scope.outputSchemaHash, validationLimit: scope.validationLimit, expiresAt: scope.expiresAt });
    return { token, revoke: () => tokens.revoke(token) };
  } },
  nodeBin: process.execPath, mcpShimEntry: join(root, "packages/mcp/dist/bin/shim.js"), env: process.env,
  validateOutput: (schema, output) => validator.compile(schema).validate(output),
});
const node = (id: string, type: string, fields: Record<string, unknown> = {}) => ({ id, type, name: id, ...fields });
const graph = (nodes: unknown[], edges: Array<[string, string]>) => ({ nodes, edges: edges.map(([from, to], i) => ({ id: `e${i}`, from, to })) });
try {
  const raw = {
    schemaVersion: 1, id: "loop-agent", name: "Loop agent",
    graph: graph([
      node("start", "start", { params: [] }),
      node("refine", "loop", {
        mode: "repeatUntil", maxIterations: 3, initialState: '{"previous":0}',
        nextState: '{"previous":result.iteration}', result: "work.received", until: "result.iteration >= 2",
        output: { type: "object", additionalProperties: true },
        body: graph([
          node("start", "start", { params: [] }),
          node("work", "agent", { cli: "fake", prompt: "Review round {{loop.iteration}}", output: { type: "object", additionalProperties: true }, permissions: { network: false, write: ["workspace"] }, workspace: { mode: "scratch" }, limits: { timeoutMin: 1, validationRetries: 0, crashRetries: 0 }, context: { project: "none", workflow: "none" } }),
          node("done", "end", { status: "success", result: "work" }),
        ], [["start", "work"], ["work", "done"]]),
      }),
      node("end", "end", { status: "success", result: "refine" }),
    ], [["start", "refine"], ["refine", "end"]]),
  };
  const parsed = parseWorkflow(raw);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error.message);
  const validation = validateWorkflow(parsed.value);
  assert.ok(validation.ok, JSON.stringify(validation.errors));
  const normalized = normalizeWorkflow(parsed.value);
  assert.ok(normalized.ok, normalized.ok ? "" : normalized.error.message);
  const outcome = await engine.run({ projectId: "p", workflowId: raw.id, snapshot: normalized.value, snapshotRaw: JSON.stringify(raw) });
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.error.message);
  assert.equal(outcome.value.status, "succeeded", JSON.stringify(outcome.value));
  const view = store.view.get(outcome.value.runId as never);
  assert.equal(view.executions.refine?.loop?.rounds.length, 2);
  for (let iteration = 1; iteration <= 2; iteration++) {
    const execution = view.executions[`refine#${iteration}/work`];
    assert.equal(execution?.status, "succeeded");
    assert.ok(execution?.acceptedResult);
    assert.ok(execution?.processStopped);
    assert.ok(execution?.workspaceFinalized);
    const output = store.outputs.get({ runId: outcome.value.runId as never, path: `refine#${iteration}/work` as never, attempt: 1 });
    const received = (output?.json as { received: { iteration: number; state: { previous: number } } }).received;
    assert.equal(received.iteration, iteration);
    assert.equal(received.state.previous, iteration - 1);
  }
  process.stdout.write("loop agent integration ok\n");
} finally {
  await engine.stop();
  await server.close();
  store.close();
  rmSync(temp, { recursive: true, force: true });
}

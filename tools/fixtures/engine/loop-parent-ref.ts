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
const temp = mkdtempSync(join(tmpdir(), "devchestra-loop-parent-ref-"));
const store = openStore({ file: join(temp, "store.db") });
const tokens = new ExecTokenRegistry({ registerSecret: (value, name) => store.security.registerSecret(value, name) });
const validator = new OutputValidator();
let port = 0;
const server = await startLoopbackServer(createAgentGateway({ tokens, submissions: store.submissions, context: store.contextPool, validator, port: () => port }));
port = server.port;
store.projects.ensure({ id: "p", name: "Loop project", path: temp, kind: "folder" });
const engine = createEngine({
  store, dataDir: temp,
  adapters: createAdapterRegistry({ fakeAgentBin: join(root, "tools/fake-agent/dist/main.js"), fakeScript: [] }),
  workspaces: { prepare: prepareRunWorkspace, acquire: acquireScratch, finalize: finalizeScratch, release: releaseScratch },
  gateway: { url: server.url, issue(scope) {
    const token = tokens.issue({ identity: scope.identity, toolset: "agent", outputSchema: scope.outputSchema, outputSchemaHash: scope.outputSchemaHash, validationLimit: scope.validationLimit, expiresAt: scope.expiresAt, context: scope.context });
    return { token, revoke: () => tokens.revoke(token) };
  } },
  nodeBin: process.execPath, mcpShimEntry: join(root, "packages/mcp/dist/bin/shim.js"), env: process.env,
  validateOutput: (schema, output) => validator.compile(schema).validate(output),
});
const blob = "x".repeat(40 * 1024);
const node = (id: string, type: string, fields: Record<string, unknown> = {}) => ({ id, type, name: id, ...fields });
const graph = (nodes: unknown[], edges: Array<[string, string]>) => ({ nodes, edges: edges.map(([from, to], i) => ({ id: `e${i}`, from, to })) });
try {
  const raw = {
    schemaVersion: 1, id: "loop-parent-ref", name: "Loop parent ref",
    graph: graph([
      node("start", "start", { params: [{ name: "blob", type: "string", required: true }] }),
      node("refine", "loop", {
        mode: "repeatUntil", maxIterations: 3, initialState: "{}",
        // Body end reduces the 40 KiB parent value; loop result stays small.
        result: "{\"n\": loop.iteration}", until: "result.n >= 1",
        output: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false },
        body: graph([
          node("start", "start", { params: [] }),
          // Proves >16 KiB parent data reaches the body through references.
          node("done", "end", { status: "success", result: "loop.parent.start.blob" }),
        ], [["start", "done"]]),
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
  const outcome = await engine.run({ projectId: "p", workflowId: raw.id, snapshot: normalized.value, snapshotRaw: JSON.stringify(raw), params: { blob } });
  assert.ok(outcome.ok, outcome.ok ? "" : outcome.error.message);
  assert.equal(outcome.value.status, "succeeded", JSON.stringify(outcome.value));
  const runId = outcome.value.runId;
  const view = store.view.get(runId as never);
  const controller = view.executions.refine?.loop;
  assert.ok(controller, "loop controller missing");
  // Projections carry only the reference.
  assert.deepEqual(controller.parent, {});
  assert.ok(controller.parentRef?.captureId);
  // Loop-start events stay small.
  const started = store.events.list(runId as never).filter((e) => e.type === "loop.started");
  assert.equal(started.length, 1);
  const payloadText = JSON.stringify((started[0] as { payload: unknown }).payload);
  assert.ok(Buffer.byteLength(payloadText, "utf8") < 4 * 1024, `loop.started too large: ${Buffer.byteLength(payloadText, "utf8")}`);
  // The 40 KiB parent reached the body through the reference.
  const bodyOutput = store.outputs.get({ runId: runId as never, path: "refine#1/done" as never, attempt: 1 });
  assert.equal(bodyOutput?.json, blob);
  // Resolution pins the same values.
  const scope = store.contextCaptures.resolve(runId as never, controller.parentRef.captureId);
  assert.equal((scope.start as { blob: string }).blob, blob);
  process.stdout.write(`loop parent ref ok ${runId} ${controller.parentRef.captureId}\n`);
} finally {
  await engine.stop();
  await server.close();
  store.close();
  rmSync(temp, { recursive: true, force: true });
}

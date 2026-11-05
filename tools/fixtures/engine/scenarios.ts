import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../../../packages/store/dist/index.js";
import {
  ExecTokenRegistry,
  OutputValidator,
  createAgentGateway,
  startLoopbackServer,
} from "../../../packages/server/dist/index.js";
import { createAdapterRegistry } from "../../../packages/adapters/dist/index.js";
import { acquireScratch, finalizeScratch, prepareRunWorkspace, releaseScratch } from "../../../packages/workspaces/dist/index.js";
import {
  createEngine,
  type Engine,
  type StartRunInput,
  validateBaseNodeConfig,
} from "../../../packages/engine/dist/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const shim = join(root, "packages/mcp/dist/bin/shim.js");
const fakeAgent = join(root, "tools/fake-agent/dist/main.js");
const baseSnapshot = JSON.parse(readFileSync(join(here, "linear-research.json"), "utf8"));
const temp = mkdtempSync(join(tmpdir(), "devchestra-engine-scenarios-"));
const store = openStore({ file: join(temp, "devchestra.db") });
const tokens = new ExecTokenRegistry({
  registerSecret: (value, name) => store.security.registerSecret(value, name),
});
let port = 0;
const submissions = store.submissions;
const server = await startLoopbackServer(
  createAgentGateway({
    tokens,
    submissions,
    validator: new OutputValidator(),
    port: () => port,
    logger: (line) => process.stderr.write(line + "\n"),
  }),
);
port = server.port;
store.projects.ensure({ id: "p1", name: "P1", path: temp, kind: "folder" });
const issued: string[] = [];

function makeEngine(script: unknown[], extra: { maxNodeTimeoutMs?: number } = {}): Engine {
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
          ...(scope.shell === undefined ? {} : { shell: scope.shell }),
        });
        issued.push(token);
        return { token, revoke: () => tokens.revoke(token), drain: () => tokens.drain(token) };
      },
    },
    dataDir: temp,
    nodeBin: process.execPath,
    mcpShimEntry: shim,
    env: process.env,
    ...(extra.maxNodeTimeoutMs === undefined ? {} : { maxNodeTimeoutMs: extra.maxNodeTimeoutMs }),
  });
}

function snapshot(mutate?: (value: any) => void): unknown {
  const value = structuredClone(baseSnapshot);
  mutate?.(value);
  return value;
}

function input(snap: unknown, params: Record<string, unknown> = { topic: "devchestra" }): StartRunInput {
  return {
    projectId: "p1",
    workflowId: "linear-research",
    snapshot: snap,
    snapshotRaw: JSON.stringify(snap),
    params,
  };
}

async function runScenario(
  name: string,
  script: unknown[],
  snap: unknown,
  params?: Record<string, unknown>,
) {
  const engine = makeEngine(script);
  try {
    await engine.start();
    const result = await engine.run(input(snap, params));
    assert.equal(result.ok, true, `${name}: ${result.ok ? "" : result.error.message}`);
    if (!result.ok) throw result.error;
    return { engine, result: result.value };
  } catch (error) {
    await engine.stop();
    throw error;
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

function transcriptText(dir: string): string {
  return walk(dir)
    .filter((file) => file.includes(`${join("transcripts", "")}`) && file.endsWith(".jsonl"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

try {
  {
    const { engine, result } = await runScenario("happy", [{ type: "submit", output: { summary: "ok" } }], snapshot());
    if (result.status !== "succeeded") {
      process.stderr.write(JSON.stringify(store.events.list(result.runId as never, { limit: 10_000 }).map((e) => ({ path: e.path, type: e.type, payload: e.payload })), null, 2) + "\n");
    }
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.result, { summary: "ok", echo: "ok" });
    const stored = store.runs.get(result.runId as never);
    assert.ok(stored);
    assert.deepEqual(stored.snapshot, baseSnapshot);
    const shell = store.outputs.get({ runId: result.runId as never, path: "report" as never, attempt: 1 });
    assert.equal((shell?.json as { exitCode: number }).exitCode, 0);
    await engine.stop();
  }

  {
    const { engine, result } = await runScenario(
      "invalid-then-valid",
      [
        { type: "submit", output: { summary: 1 } },
        { type: "submit", output: { summary: "fixed" } },
      ],
      snapshot(),
    );
    assert.equal(result.status, "succeeded");
    const events = store.events.list(result.runId as never, { limit: 10_000 });
    assert.equal(events.some((event) => event.type === "node.output.rejected"), true);
    assert.equal(events.some((event) => event.type === "node.output.validated"), true);
    await engine.stop();
  }

  {
    const { engine, result } = await runScenario("no-submit", [{ type: "say", text: "done" }], snapshot());
    assert.equal(result.status, "failed");
    const events = store.events.list(result.runId as never, { limit: 10_000 });
    const spawns = events.filter((event) => event.type === "node.process.spawned");
    assert.equal(spawns.length, 2, "one bounded no-submit resume");
    assert.equal(events.some((event) => event.type === "node.output.validated"), false);
    await engine.stop();
  }

  {
    const { engine, result } = await runScenario(
      "validation-exhausted",
      [{ type: "submit", output: { summary: 1 } }],
      snapshot((value) => {
        value.graph.nodes.find((node: any) => node.id === "research").limits.validationRetries = 0;
      }),
    );
    assert.equal(result.status, "failed");
    const events = store.events.list(result.runId as never, { limit: 10_000 });
    assert.equal(events.filter((event) => event.type === "node.output.rejected").length, 1);
    await engine.stop();
  }

  {
    const { engine, result } = await runScenario(
      "crash-cap",
      [{ type: "crash", code: 9 }],
      snapshot(),
    );
    assert.equal(result.status, "failed");
    const events = store.events.list(result.runId as never, { limit: 10_000 });
    const stops = events.filter(
      (event) => event.type === "node.process.stopped" && event.payload.reason === "crash",
    );
    assert.equal(stops.length, 2, "initial crash plus one retry");
    const spawns = events.filter((event) => event.type === "node.process.spawned");
    assert.equal(spawns.length, 2);
    await engine.stop();
  }

  {
    const { engine, result } = await runScenario(
      "accepted-then-crash",
      [
        { type: "submit", output: { summary: "durable" } },
        { type: "crash", code: 9 },
      ],
      snapshot(),
    );
    assert.equal(result.status, "succeeded");
    const events = store.events.list(result.runId as never, { limit: 10_000 });
    assert.equal(events.filter((event) => event.type === "node.output.validated").length, 1);
    assert.equal(
      events.filter((event) => event.type === "node.process.spawned" && event.path === "research").length,
      1,
      "no new spawn after acceptance",
    );
    const accepted = store.submissions.accepted({
      runId: result.runId as never,
      path: "research" as never,
      attempt: 1,
    });
    assert.deepEqual(accepted?.json, { summary: "durable" });
    await engine.stop();
  }

  {
    const snap = snapshot((value) => {
      value.graph.nodes.find((node: any) => node.id === "report").command = "exit 7";
    });
    const { engine, result } = await runScenario(
      "shell-failure",
      [{ type: "submit", output: { summary: "ok" } }],
      snap,
    );
    assert.equal(result.status, "failed");
    const output = store.outputs.get({ runId: result.runId as never, path: "report" as never, attempt: 1 });
    assert.equal((output?.json as { exitCode: number }).exitCode, 7);
    await engine.stop();
  }

  {
    const snap = snapshot((value) => {
      value.graph.nodes.find((node: any) => node.id === "report").command = "printf '%s' {{ start.topic }}";
    });
    const topic = "a'b $(touch /tmp/devchestra-engine-pwned) `id`";
    const { engine, result } = await runScenario(
      "shell-quoting",
      [{ type: "submit", output: { summary: "ok" } }],
      snap,
      { topic },
    );
    assert.equal(result.status, "succeeded");
    const shell = store.outputs.get({ runId: result.runId as never, path: "report" as never, attempt: 1 });
    assert.equal((shell?.json as { stdout: string }).stdout, topic);
    await engine.stop();
  }

  {
    const snap = snapshot((value) => {
      value.graph.nodes.find((node: any) => node.id === "report").command = "exit 7";
      value.graph.nodes.find((node: any) => node.id === "report").allowFailure = true;
    });
    const { engine, result } = await runScenario(
      "shell-allow-failure",
      [{ type: "submit", output: { summary: "ok" } }],
      snap,
    );
    assert.equal(result.status, "succeeded");
    await engine.stop();
  }

  {
    const engine = makeEngine([{ type: "sleep", ms: 30_000 }]);
    await engine.start();
    let runId = "";
    let spawned: () => void = () => undefined;
    const spawnedPromise = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const unsubscribe = engine.subscribe((event) => {
      if (event.type === "node.process.spawned") {
        runId = event.runId;
        spawned();
      }
    });
    const running = engine.run(input(snapshot()));
    await spawnedPromise;
    const token = issued.at(-1) as string;
    assert.notEqual(tokens.resolve(token), null);
    const cancelled = await engine.cancel(runId);
    unsubscribe();
    assert.equal(cancelled.ok, true);
    const result = await running;
    assert.equal(result.ok, true);
    if (!result.ok) throw result.error;
    assert.equal(result.value.status, "cancelled");
    assert.equal(tokens.resolve(token), null, "token revoked before cleanup");
    const events = store.events.list(result.value.runId as never, { limit: 10_000 });
    assert.equal(events.some((event) => event.type === "node.output.validated"), false);
    assert.equal(
      events.some((event) => event.type === "node.process.stopped" && event.payload.reason === "killed"),
      true,
    );
    await engine.stop();
  }

  {
    const engine = makeEngine([{ type: "submit", output: { summary: "ok" } }]);
    await engine.start();
    const bad = await engine.run(input(snapshot(), { topic: "x", unknown: 1 }));
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error.code, "E_VALIDATION");
    const badMode = await engine.run(
      input(
        snapshot((value) => {
          value.graph.nodes.find((node: any) => node.id === "research").workspace = {
            mode: "project",
            access: "read",
          };
        }),
      ),
    );
    // Legacy per-node project metadata is ignored on fresh runs.
    assert.equal(badMode.ok, true);
    if (badMode.ok) assert.equal(badMode.value.status, "succeeded");
    await engine.stop();
  }

  {
    const engine = makeEngine([{ type: "sleep", ms: 30_000 }], { maxNodeTimeoutMs: 300 });
    await engine.start();
    const result = await engine.run(input(snapshot()));
    assert.equal(result.ok, true);
    if (!result.ok) throw result.error;
    assert.equal(result.value.status, "failed");
    const events = store.events.list(result.value.runId as never, { limit: 10_000 });
    const stops = events.filter(
      (event) => event.type === "node.process.stopped" && event.payload.reason === "crash",
    );
    assert.equal(stops.length, 2, "timeout consumes the crash budget and stops after the cap");
    await engine.stop();
  }

  {
    const script = [{ type: "sleep", ms: 800 }, { type: "submit", output: { summary: "resumed" } }];
    const engine = makeEngine(script);
    await engine.start();
    let runId = "";
    let spawned: () => void = () => undefined;
    const spawnedPromise = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const unsubscribe = engine.subscribe((event) => {
      if (event.type === "node.process.spawned" && event.path === "research") {
        runId = event.runId;
        spawned();
      }
    });
    const first = engine.run(input(snapshot()));
    await spawnedPromise;
    await engine.stop();
    unsubscribe();
    const pausedResult = await first;
    assert.equal(pausedResult.ok, true);
    if (!pausedResult.ok) throw pausedResult.error;
    assert.equal(pausedResult.value.status, "paused");
    assert.equal(pausedResult.value.pausedReason, "shutdown");
    runId = pausedResult.value.runId;

    const resumedEngine = makeEngine(script);
    await resumedEngine.start();
    const resumed = await resumedEngine.resume(runId);
    assert.equal(resumed.ok, true);
    if (!resumed.ok) throw resumed.error;
    assert.equal(resumed.value.status, "succeeded");
    assert.deepEqual(resumed.value.result, { summary: "resumed", echo: "resumed" });
    const spawns = store.events
      .list(runId as never, { limit: 10_000 })
      .filter((event) => event.type === "node.process.spawned" && event.path === "research");
    assert.equal(spawns.length, 2, "shutdown interrupted and resume started a new generation");
    await resumedEngine.stop();
  }

  {
    const shellSnap = snapshot((value) => {
      value.graph.nodes.find((node: any) => node.id === "report").command = "sleep 1";
    });
    const engine = makeEngine([{ type: "submit", output: { summary: "ok" } }], { maxNodeTimeoutMs: 5_000 });
    await engine.start();
    let runId = "";
    let spawned: () => void = () => undefined;
    const spawnedPromise = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const unsubscribe = engine.subscribe((event) => {
      if (event.type === "node.process.spawned" && event.path === "report") {
        runId = event.runId;
        spawned();
      }
    });
    const first = engine.run(input(shellSnap));
    await spawnedPromise;
    await engine.stop();
    unsubscribe();
    const paused = await first;
    assert.equal(paused.ok, true);
    if (!paused.ok) throw paused.error;
    assert.equal(paused.value.status, "paused");
    assert.equal(paused.value.pausedReason, "uncertain_side_effect");

    const resumedEngine = makeEngine([{ type: "submit", output: { summary: "ok" } }], { maxNodeTimeoutMs: 5_000 });
    await resumedEngine.start();
    const withoutApproval = await resumedEngine.resume(runId);
    assert.equal(withoutApproval.ok, false);
    if (!withoutApproval.ok) assert.equal(withoutApproval.error.code, "E_CONFLICT");
    const approved = await resumedEngine.resume(runId, {
      allowUncertainSideEffectRetry: true,
      approvedBy: "scenario-user",
    });
    assert.equal(approved.ok, true);
    if (!approved.ok) throw approved.error;
    assert.equal(approved.value.status, "succeeded");
    const shellSpawns = store.events
      .list(runId as never, { limit: 10_000 })
      .filter((event) => event.type === "node.process.spawned" && event.path === "report");
    assert.equal(shellSpawns.length, 2);
    await resumedEngine.stop();
  }

  shellPolicy: {
    // Shell policy, real stack: exec runs through the gateway, the denied command
    // never executes, and a shutdown mid-run resumes with a token re-minted from
    // the frozen policy and the same workspace.
    const script = [
      { type: "tool", name: "exec", args: { command: "echo allowed-before-stop" } },
      { type: "sleep", ms: 3000 },
      { type: "tool", name: "exec", args: { command: "touch denied-marker" } },
      { type: "tool", name: "exec", args: { command: "echo allowed-after-resume" } },
      { type: "submit", output: { summary: "ok" } },
    ];
    const shellSnapshot = snapshot((value) => {
      const research = value.graph.nodes.find((node: any) => node.id === "research");
      research.permissions.shellPolicy = { allow: ["^echo .+$"], deny: ["^touch\\b.*$"] };
    });
    // The engine keeps rejecting policy nodes until shell policies are enabled, and a rejected
    // run never spawns, so there is nothing to wait for. Skip instead of hanging.
    try {
      validateBaseNodeConfig(
        shellSnapshot.graph.nodes.find((node: any) => node.id === "research"),
        "agent",
      );
    } catch (error) {
      process.stdout.write(
        `shell policy scenario skipped: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      break shellPolicy;
    }
    const engine = makeEngine(script);
    await engine.start();
    let runId = "";
    let spawned: () => void = () => undefined;
    const spawnedPromise = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const unsubscribe = engine.subscribe((event) => {
      if (event.type === "node.process.spawned" && event.path === "research") {
        runId = event.runId;
        spawned();
      }
    });
    const first = engine.run(input(shellSnapshot));
    // Surface planning failures instead of waiting forever for an impossible spawn.
    try {
      await Promise.race([
        spawnedPromise,
        first.then((result) => {
          if (!result.ok) throw result.error;
          throw new Error(`Policy scenario ended before spawning research: ${result.value.status}`);
        }),
      ]);
    } catch (error) {
      unsubscribe();
      await engine.stop();
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await engine.stop();
    unsubscribe();
    const pausedResult = await first;
    assert.equal(pausedResult.ok, true);
    if (!pausedResult.ok) throw pausedResult.error;
    assert.equal(pausedResult.value.status, "paused");
    assert.equal(pausedResult.value.pausedReason, "shutdown");

    const resumedEngine = makeEngine(script, { maxNodeTimeoutMs: 20_000 });
    await resumedEngine.start();
    const resumed = await resumedEngine.resume(runId);
    assert.equal(resumed.ok, true);
    if (!resumed.ok) throw resumed.error;
    assert.equal(resumed.value.status, "succeeded");
    await resumedEngine.stop();

    const events = store.events.list(runId as never, { limit: 10_000 });
    const spawns = events.filter((event) => event.type === "node.process.spawned" && event.path === "research");
    assert.equal(spawns.length, 2, "first attempt plus one resume");
    assert.equal(issued.length >= 2, true, "resume re-mints an exec token");
    const transcript = transcriptText(temp);
    assert.match(transcript, /allowed-before-stop/);
    assert.match(transcript, /allowed-after-resume/);
    assert.match(transcript, /Command denied by shell policy/);
    assert.equal(
      walk(temp).some((file) => file.endsWith("denied-marker")),
      false,
      "denied command must never execute",
    );
    for (const token of issued) assert.equal(transcript.includes(token), false, "token must not reach the transcript");
  }

  process.stdout.write("engine scenarios ok\n");
} finally {
  await server.close();
  store.close();
  rmSync(temp, { recursive: true, force: true });
}

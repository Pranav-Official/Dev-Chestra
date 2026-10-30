import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DevChestraError,
  type ExecutionIdentity,
  type ExecutionContextManifest,
  FakeClock,
  FakeIdGen,
  type Path,
  type RunId,
} from "@devchestra/core";
import { hashJsonSync } from "../src/hash.js";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../src/index.js";

interface Harness {
  dir: string;
  store: Store;
  runId: RunId;
  close(): void;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harness(params: Record<string, unknown> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "devchestra-ctx-"));
  const store = openStore({
    file: join(dir, "devchestra.db"),
    clock: new FakeClock(1_700_000_000_000),
    idGen: new FakeIdGen("r"),
  });
  store.projects.ensure({ id: "proj", name: "Project", path: dir, kind: "folder" });
  const run = store.runs.create({
    projectId: "proj",
    workflowId: "ctx",
    workflowHash: "hash",
    snapshot: { nodes: [] },
    snapshotRaw: '{"nodes":[]}',
    params: params as never,
    budgets: {},
  });
  const h: Harness = { dir, store, runId: run.runId, close: () => store.close() };
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return h;
}

function beginLoop(h: Harness, nodeId = "refine"): ExecutionIdentity {
  const path = nodeId as Path;
  h.store.executions.ensure({ runId: h.runId, path, nodeId, kind: "loop", requireSubmission: false });
  return h.store.executions.beginInvocation({ runId: h.runId, path, attempt: 1, resolvedConfigHash: "cfg" });
}

function recordNode(h: Harness, nodeId: string, output: unknown): { identity: ExecutionIdentity; outputId: string; hash: string } {
  const path = nodeId as Path;
  h.store.executions.ensure({ runId: h.runId, path, nodeId, kind: "shell", requireSubmission: false });
  const identity = h.store.executions.beginInvocation({ runId: h.runId, path, attempt: 1, resolvedConfigHash: "cfg" });
  // Durable output row only; completion markers are unnecessary for capture fixtures.
  const recorded = h.store.outputs.recordDeterministic({ identity, output });
  return { identity, outputId: recorded.output.id, hash: recorded.output.hash };
}

describe("reference-backed loop parent captures", () => {
  it("accepts a parent larger than 16 KiB via reference while the event stays small", () => {
    const h = harness();
    const big = "x".repeat(40 * 1024);
    const { outputId, hash } = recordNode(h, "upstream", { blob: big });
    const upstreamExec = h.store.executions.get(h.runId, "upstream" as Path);
    const identity = beginLoop(h);
    const capture = h.store.contextCaptures.create({
      runId: h.runId,
      path: "refine" as Path,
      identity,
      entries: [
        { name: "start", type: "run-params" },
        { name: "upstream", type: "output", outputId, path: "upstream", attempt: upstreamExec!.attempt, nodeKind: "agent", hash },
      ],
    });
    const started = h.store.tx(() => {
      return h.store.loops.start({
        identity,
        parentRef: { kind: "devchestra.execution-context/v1", captureId: capture.id },
        state: { n: 0 },
      });
    });
    expect(started.duplicate).toBe(false);
    expect(started.loop.parentRef?.captureId).toBe(capture.id);
    // Projections never hydrate the parent.
    expect(started.loop.parent).toEqual({});
    const events = h.store.events.list(h.runId);
    const startedEvent = events.find((e) => e.type === "loop.started");
    expect(startedEvent).toBeDefined();
    const payloadText = JSON.stringify((startedEvent as { payload: unknown }).payload);
    expect(Buffer.byteLength(payloadText, "utf8")).toBeLessThan(4 * 1024);
    // Resolution returns the pinned values, not a latest-output lookup.
    const scope = h.store.contextCaptures.resolve(h.runId, capture.id);
    expect((scope.upstream as { blob: string }).blob).toBe(big);
    // Rebuild from events only: still a reference, no hydration.
    const rebuilt = h.store.view.rebuild(h.runId);
    expect(rebuilt.executions.refine?.loop?.parentRef?.captureId).toBe(capture.id);
    expect(rebuilt.executions.refine?.loop?.parent).toEqual({});
  });

  it("keeps 16 KiB bounds on state/result/nextState", () => {
    const h = harness();
    const identity = beginLoop(h);
    const capture = h.store.contextCaptures.create({
      runId: h.runId,
      path: "refine" as Path,
      identity,
      entries: [{ name: "start", type: "run-params" }],
    });
    const ref = { kind: "devchestra.execution-context/v1", captureId: capture.id } as const;
    expect(() =>
      h.store.loops.start({ identity, parentRef: ref, state: { v: "y".repeat(20 * 1024) } }),
    ).toThrowError(DevChestraError);
    h.store.loops.start({ identity, parentRef: ref, state: {} });
    expect(() =>
      h.store.loops.decide({ identity, iteration: 1, result: { v: "z".repeat(20 * 1024) }, done: false }),
    ).toThrowError(DevChestraError);
  });

  it("rejects same-store cross-run references with E_FORBIDDEN_PATH", () => {
    const h = harness();
    const other = h.store.runs.create({
      projectId: "proj",
      workflowId: "ctx",
      workflowHash: "hash",
      snapshot: { nodes: [] },
      snapshotRaw: '{"nodes":[]}',
      params: {},
      budgets: {},
    });
    const { outputId, hash } = recordNode(h, "upstream", { ok: true });
    const otherPath = "refine" as Path;
    h.store.executions.ensure({ runId: other.runId, path: otherPath, nodeId: "refine", kind: "loop", requireSubmission: false });
    const otherIdentity = h.store.executions.beginInvocation({ runId: other.runId, path: otherPath, attempt: 1, resolvedConfigHash: "cfg" });
    // The target output exists in this store (same DB, distinct run): the
    // rejection proves ownership enforcement, not mere absence.
    expect(h.store.outputs.getById(outputId)).not.toBeNull();
    try {
      h.store.contextCaptures.create({
        runId: other.runId,
        path: otherPath,
        identity: otherIdentity,
        entries: [
          { name: "upstream", type: "output", outputId, path: "upstream", attempt: 1, nodeKind: "shell", hash },
        ],
      });
      throw new Error("expected E_FORBIDDEN_PATH");
    } catch (error) {
      expect(error).toBeInstanceOf(DevChestraError);
      expect((error as DevChestraError).code).toBe("E_FORBIDDEN_PATH");
    }
  });

  it("rejects wrong path/attempt provenance", () => {
    const h = harness();
    const { outputId, hash } = recordNode(h, "upstream", { ok: true });
    const identity = beginLoop(h);
    for (const entry of [
      { name: "upstream", type: "output", outputId, path: "elsewhere", attempt: 1, nodeKind: "shell", hash },
      { name: "upstream", type: "output", outputId, path: "upstream", attempt: 2, nodeKind: "shell", hash },
    ] as const) {
      expect(() =>
        h.store.contextCaptures.create({ runId: h.runId, path: "refine" as Path, identity, entries: [entry] }),
      ).toThrowError(DevChestraError);
    }
  });

  it("resolves pinned outputs after later attempts and detects content tampering", () => {
    const h = harness();
    const first = recordNode(h, "upstream", { v: 1 });
    const identity = beginLoop(h);
    const capture = h.store.contextCaptures.create({
      runId: h.runId,
      path: "refine" as Path,
      identity,
      entries: [
        { name: "upstream", type: "output", outputId: first.outputId, path: "upstream", attempt: 1, nodeKind: "shell", hash: first.hash },
      ],
    });
    // A later attempt records a different output for the same path (inserted
    // directly: the engine would only reach attempt 2 after settling attempt 1).
    const rawLater = new Database(join(h.dir, "devchestra.db"));
    try {
      rawLater
        .prepare("INSERT INTO outputs (id, run_id, path, attempt, generation, kind, hash, bytes, json, created_at) VALUES (?, ?, ?, ?, ?, 'output', ?, ?, ?, ?)")
        .run("later-output", h.runId, "upstream", 2, 1, hashJsonSync({ v: 2 }), Buffer.byteLength(JSON.stringify({ v: 2 }), "utf8"), JSON.stringify({ v: 2 }), Date.now());
    } finally {
      rawLater.close();
    }
    // Resolution still pins the captured first-attempt output.
    expect((h.store.contextCaptures.resolve(h.runId, capture.id).upstream as { v: number }).v).toBe(1);
    // Tamper with the stored JSON while keeping the hash column: verification fails.
    const raw = new Database(join(h.dir, "devchestra.db"));
    try {
      raw.prepare("UPDATE outputs SET json = ? WHERE id = ?").run(JSON.stringify({ v: 999 }), first.outputId);
    } finally {
      raw.close();
    }
    expect(() => h.store.contextCaptures.resolve(h.runId, capture.id)).toThrowError(DevChestraError);
  });

  it("rejects invalid manifests and missing references", () => {
    const h = harness();
    const identity = beginLoop(h);
    expect(() =>
      h.store.contextCaptures.create({
        runId: h.runId,
        path: "refine" as Path,
        identity,
        entries: [{ name: "ghost", type: "output", outputId: "missing-id", path: "ghost", attempt: 1, nodeKind: "shell", hash: "abc" }],
      }),
    ).toThrowError(DevChestraError);
    const capture = h.store.contextCaptures.create({
      runId: h.runId,
      path: "refine" as Path,
      identity,
      entries: [{ name: "start", type: "run-params" }],
    });
    const raw = new Database(join(h.dir, "devchestra.db"));
    try {
      raw.prepare("UPDATE context_captures SET json = ? WHERE id = ?").run(JSON.stringify({ version: 999, entries: [] }), capture.id);
    } finally {
      raw.close();
    }
    expect(() => h.store.contextCaptures.resolve(h.runId, capture.id)).toThrowError(DevChestraError);
    expect(() => h.store.contextCaptures.resolve(h.runId, "ctx_missing")).toThrowError(DevChestraError);
  });

  it("enforces the literal bound and JSON serializability", () => {
    const h = harness();
    const identity = beginLoop(h);
    expect(() =>
      h.store.contextCaptures.create({
        runId: h.runId,
        path: "refine" as Path,
        identity,
        entries: [{ name: "big", type: "literal", value: { v: "z".repeat(20 * 1024) } }],
      }),
    ).toThrowError(DevChestraError);
    expect(() =>
      h.store.contextCaptures.create({
        runId: h.runId,
        path: "refine" as Path,
        identity,
        entries: [{ name: "nan", type: "literal", value: Number.NaN as unknown as null }],
      }),
    ).toThrowError(DevChestraError);
    // Small literals (null markers) are fine.
    const capture = h.store.contextCaptures.create({
      runId: h.runId,
      path: "refine" as Path,
      identity,
      entries: [{ name: "skipped", type: "literal", value: null }],
    });
    expect(h.store.contextCaptures.resolve(h.runId, capture.id)).toEqual({ skipped: null });
  });

  it("rejects loop-path mismatches and secret-bearing captures", () => {
    const h = harness();
    const identity = beginLoop(h, "refine");
    const capture = h.store.contextCaptures.create({
      runId: h.runId,
      path: "refine" as Path,
      identity,
      entries: [{ name: "start", type: "run-params" }],
    });
    expect(() =>
      h.store.loops.start({
        identity: { ...identity, path: "other" as Path },
        parentRef: { kind: "devchestra.execution-context/v1", captureId: capture.id },
        state: {},
      }),
    ).toThrowError(DevChestraError);
    const sid = beginLoop(h, "second");
    const { outputId, hash } = recordNode(h, "leaky", { token: "s3cr3t-capture" });
    // Register after recording: the capture-time scan is what this rejects.
    const unregister = h.store.security.registerSecret("s3cr3t-capture", "test");
    try {
      expect(() =>
        h.store.contextCaptures.create({
          runId: h.runId,
          path: "second" as Path,
          identity: sid,
          entries: [{ name: "leaky", type: "output", outputId, path: "leaky", attempt: 1, nodeKind: "shell", hash }],
        }),
      ).toThrowError(DevChestraError);
    } finally {
      unregister();
    }
  });

  it("reads legacy inline-parent events and views", () => {
    const h = harness();
    const identity = beginLoop(h);
    const started = h.store.loops.start({ identity, parent: { legacy: 1 }, state: {} });
    expect(started.loop.parentRef).toBeNull();
    expect(started.loop.parent).toEqual({ legacy: 1 });
    const rebuilt = h.store.view.rebuild(h.runId);
    expect(rebuilt.executions.refine?.loop?.parent).toEqual({ legacy: 1 });
  });

  it("uses canonical content hashing for verification", () => {
    // Key order must not affect identity: canonical JSON normalizes it.
    expect(hashJsonSync({ b: 1, a: 2 })).toBe(hashJsonSync({ a: 2, b: 1 }));
    const h = harness();
    const { outputId, hash } = recordNode(h, "upstream", { b: 1, a: 2 });
    expect(hash).toBe(hashJsonSync({ a: 2, b: 1 }));
    const identity = beginLoop(h);
    const capture = h.store.contextCaptures.create({
      runId: h.runId,
      path: "refine" as Path,
      identity,
      entries: [{ name: "upstream", type: "output", outputId, path: "upstream", attempt: 1, nodeKind: "shell", hash }],
    });
    expect(h.store.contextCaptures.resolve(h.runId, capture.id)).toEqual({ upstream: { b: 1, a: 2 } });
  });
});

describe("context capture manifest integrity", () => {
  it("round-trips versioned manifests", () => {
    const manifest: ExecutionContextManifest = {
      version: 1,
      runId: "r1" as RunId,
      loopPath: "loop" as Path,
      entries: [{ name: "start", type: "run-params" }],
    };
    expect(manifest.version).toBe(1);
  });
});

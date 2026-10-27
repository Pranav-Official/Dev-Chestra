import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRunWorkspaceBinding, RelayError } from "@relay/core";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "../src/index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "relay-store-workspace-"));
  const file = join(dir, "relay.db");
  const store = openStore({ file });
  store.projects.ensure({ id: "p1", name: "P1", path: join(dir, "project"), kind: "git" });
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file, store };
}

function create(store: ReturnType<typeof openStore>, workspace?: unknown) {
  return store.runs.create({
    projectId: "p1",
    workflowId: "w",
    workflowHash: "hash",
    snapshot: { nodes: [] },
    snapshotRaw: '{"nodes":[]}',
    ...(workspace === undefined ? {} : { workspace: workspace as never }),
  });
}

describe("run workspace persistence", () => {
  it("roundtrips a frozen binding and leaves manual legacy runs null", () => {
    const { store } = harness();
    const binding = {
      selection: { mode: "existing-worktree", path: "/repo/wt" },
      projectRoot: "/repo",
    };
    const created = create(store, binding);
    const run = store.runs.get(created.runId);
    expect(run?.workspace).toEqual(binding);

    const legacy = create(store);
    expect(store.runs.get(legacy.runId)?.workspace).toBeNull();
  });

  it("rejects a malformed binding at create time", () => {
    const { store } = harness();
    expect(() => create(store, { selection: { mode: "project" } })).toThrow(RelayError);
    expect(() =>
      create(store, { selection: { mode: "existing-worktree" }, projectRoot: "/repo" }),
    ).toThrow(RelayError);
  });

  it("fails closed when a non-null stored binding is corrupt", () => {
    const { file, store } = harness();
    const binding = { selection: { mode: "project" }, projectRoot: "/repo" };
    const created = create(store, binding);
    store.close();
    const db = new Database(file);
    db.prepare("UPDATE runs SET workspace_json = ? WHERE id = ?").run(
      JSON.stringify({ selection: { mode: "scratch" }, projectRoot: "/repo" }),
      created.runId,
    );
    db.close();
    const reopened = openStore({ file });
    cleanups.push(() => reopened.close());
    let thrown: unknown;
    try {
      reopened.runs.get(created.runId);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RelayError);
    expect((thrown as RelayError).code).toBe("E_INTERNAL");
  });

  it("migrates a v2 database with existing runs to null workspace and preserves them", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-store-v2-"));
    const file = join(dir, "relay.db");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const db = new Database(file);
    const migration = (name: string) =>
      readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), "utf8");
    db.exec(migration("0001_init.sql"));
    db.exec(migration("0002_process_identity.sql"));
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 1), (2, 2)").run();
    db.exec("PRAGMA user_version = 2");
    db.prepare(
      `INSERT INTO projects (id, name, path, kind, added_at)
       VALUES ('p1', 'P1', ?, 'git', 1)`,
    ).run(join(dir, "old-project"));
    db.prepare(
      `INSERT INTO runs
         (id, project_id, workflow_id, run_number, kind, status, workflow_hash,
          snapshot_json, snapshot_raw, params_json, budgets_json, created_at)
       VALUES ('old-run', 'p1', 'w', 1, 'run', 'running', 'h',
               '{"graph":{"nodes":[]}}', 'raw', '{}', '{}', 1)`,
    ).run();
    db.prepare("UPDATE projects SET next_run_number = 2 WHERE id = 'p1'").run();
    db.close();

    const store = openStore({ file });
    cleanups.push(() => store.close());
    const old = store.runs.get("old-run" as never);
    expect(old?.workspace).toBeNull();
    expect(old?.snapshot).toEqual({ graph: { nodes: [] } });
    expect(old?.project.path).toBe(join(dir, "old-project"));

    const created = create(store, {
      selection: { mode: "project" },
      projectRoot: join(dir, "relay-project"),
    });
    expect(store.runs.get(created.runId)?.workspace).toEqual({
      selection: { mode: "project" },
      projectRoot: join(dir, "relay-project"),
    });
  });

  it("validates the binding guard used by the store", () => {
    expect(isRunWorkspaceBinding({ selection: { mode: "project" }, projectRoot: "/repo" })).toBe(
      true,
    );
  });
});

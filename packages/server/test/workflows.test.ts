import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowFile } from "@relay/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelayError } from "../src/errors.js";
import { ManagedWorkflowService, type WorkflowProject } from "../src/workflows/service.js";

let root: string;
let dataDir: string;
let projectPath: string;
let service: ManagedWorkflowService;
let project: WorkflowProject;

function failure(promise: Promise<unknown>): Promise<RelayError> {
  return promise.then(
    () => {
      throw new Error("expected failure");
    },
    (error: unknown) => {
      if (!(error instanceof RelayError)) throw error;
      return error;
    },
  );
}

function failureSync(run: () => unknown): RelayError {
  try {
    run();
  } catch (error) {
    if (error instanceof RelayError) return error;
    throw error;
  }
  throw new Error("expected failure");
}

function etagOf(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

async function tempFiles(): Promise<string[]> {
  try {
    return (await readdir(join(projectPath, ".relay", "workflows"))).filter((name) =>
      name.endsWith(".tmp"),
    );
  } catch {
    return [];
  }
}

function linear(id: string, name: string): WorkflowFile {
  return {
    schemaVersion: 1,
    id,
    name,
    graph: {
      nodes: [
        { id: "start", type: "start", name: "Start", params: [] },
        {
          id: "agent",
          type: "agent",
          name: "Agent",
          cli: "codex",
          prompt: "hello",
          output: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false,
          },
          permissions: { network: false, write: [] },
          workspace: { mode: "scratch" },
        },
        { id: "end", type: "end", name: "End", status: "success", result: "agent" },
      ],
      edges: [
        { id: "e1", from: "start", to: "agent" },
        { id: "e2", from: "agent", to: "end" },
      ],
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "relay-wf-"));
  dataDir = join(root, "data");
  projectPath = join(root, "project");
  await mkdir(dataDir, { recursive: true });
  await mkdir(projectPath, { recursive: true });
  service = new ManagedWorkflowService({ dataDir });
  project = { id: "p1", path: projectPath, kind: "folder", missing: false };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("managed workflow persistence", () => {
  it("creates drafts under .relay/workflows and lists them with validation", async () => {
    const document = await service.create(project, { name: "My Workflow", template: "blank" });
    expect(document.workflow.id).toBe("my-workflow");
    expect(document.relativeFile).toBe(".relay/workflows/my-workflow.json");
    expect(document.validation.ok).toBe(false);
    const text = await readFile(join(projectPath, document.relativeFile), "utf8");
    expect(text).toBe(document.text);
    expect(text.endsWith("\n")).toBe(true);
    expect(document.etag).toBe(etagOf(document.text));

    const items = service.listPage(project, { limit: 500 }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("my-workflow");
    expect(items[0]?.validationSummary.ok).toBe(false);
  });

  it("creates the linear-fake template as a valid workflow", async () => {
    const document = await service.create(project, { name: "Linear", template: "linear-fake" });
    expect(document.validation.ok).toBe(true);
    expect(document.workflow.graph.nodes).toHaveLength(3);
    const agent = document.workflow.graph.nodes.find((node) => node.type === "agent");
    expect(agent).toBeDefined();
    // The workspace belongs to the run, not the workflow template.
    expect(agent).not.toHaveProperty("workspace");
  });

  it("is exclusive on create even for an explicit id", async () => {
    const first = await service.create(project, { name: "One", id: "same" });
    const error = await failure(service.create(project, { name: "Two", id: "same" }));
    expect(error.code).toBe("E_CONFLICT");
    const onDisk = await readFile(join(projectPath, first.relativeFile), "utf8");
    expect(onDisk).toBe(first.text);
    expect(await tempFiles()).toEqual([]);
  });

  it("is byte-stable across repeated saves and keeps ui and array order", async () => {
    const document = await service.create(project, { name: "Stable", template: "linear-fake" });
    const once = await service.save(
      project,
      document.workflow.id,
      document.workflow,
      document.etag,
    );
    const twice = await service.save(project, once.workflow.id, once.workflow, once.etag);
    expect(twice.text).toBe(once.text);
    expect(twice.etag).toBe(once.etag);
    expect(twice.etag).toBe(etagOf(twice.text));
    const ui = twice.workflow.graph.nodes[0]?.ui;
    expect(ui).toEqual({ x: 80, y: 160 });
  });

  it("saves semantically invalid drafts but returns the errors", async () => {
    const document = await service.create(project, { name: "Draft", template: "blank" });
    const saved = await service.save(
      project,
      document.workflow.id,
      document.workflow,
      document.etag,
    );
    expect(saved.validation.ok).toBe(false);
    expect(saved.validation.errors.length).toBeGreaterThan(0);
    expect(service.listPage(project, { limit: 500 }).items[0]?.validationSummary.ok).toBe(false);
  });

  it("rejects a body id that does not match the file stem", async () => {
    const document = await service.create(project, { name: "Mismatch", id: "mismatch" });
    const error = await failure(
      service.save(project, "mismatch", { ...document.workflow, id: "other" }, document.etag),
    );
    expect(error.code).toBe("E_VALIDATION");
  });

  it("serializes two same-ETag writers so one wins and one conflicts", async () => {
    const document = await service.create(project, { name: "Race", template: "blank" });
    const left = { ...document.workflow, name: "Left" };
    const right = { ...document.workflow, name: "Right" };
    const results = await Promise.allSettled([
      service.save(project, document.workflow.id, left, document.etag),
      service.save(project, document.workflow.id, right, document.etag),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(RelayError);
    expect((reason as RelayError).code).toBe("E_CONFLICT");
  });

  it("detects an ordinary external edit as a conflict and preserves it", async () => {
    const document = await service.create(project, { name: "External", template: "linear-fake" });
    const path = join(projectPath, document.relativeFile);
    const edited = document.text.replace("External", "External edited");
    await writeFile(path, edited, "utf8");
    const error = await failure(
      service.save(project, document.workflow.id, document.workflow, document.etag),
    );
    expect(error.code).toBe("E_CONFLICT");
    expect((error.details as { currentEtag?: string }).currentEtag).not.toBe(document.etag);
    expect(await readFile(path, "utf8")).toBe(edited);
    expect(await tempFiles()).toEqual([]);
  });

  it("rejects a run whose desired etag no longer matches the file", async () => {
    const document = await service.create(project, { name: "Run", template: "linear-fake" });
    const path = join(projectPath, document.relativeFile);
    await writeFile(path, document.text.replace("Say hello", "Say goodbye"), "utf8");
    const error = await failure(
      service.run(project, document.workflow.id, { params: {}, etag: document.etag }),
    );
    expect(error.code).toBe("E_CONFLICT");
    expect((error.details as { currentEtag?: string }).currentEtag).toBeDefined();
  });

  it("snapshots past runs independently of later edits", async () => {
    const document = await service.create(project, { name: "Snapshot", template: "linear-fake" });
    const run = await service.run(project, document.workflow.id, {
      params: {},
      etag: document.etag,
    });
    await service.save(
      project,
      document.workflow.id,
      { ...document.workflow, name: "Renamed" },
      document.etag,
    );
    expect(run.snapshotRaw).toBe(document.text);
    expect(run.snapshot.name).toBe("Snapshot");
    const current = service.get(project, document.workflow.id);
    expect(current.workflow.name).toBe("Renamed");
  });

  it("persists across a fresh service instance", async () => {
    const document = await service.create(project, { name: "Restart", template: "linear-fake" });
    const restarted = new ManagedWorkflowService({ dataDir });
    const loaded = restarted.get(project, document.workflow.id);
    expect(loaded.text).toBe(document.text);
    expect(loaded.etag).toBe(document.etag);
  });

  it("keeps the same workflow id independent across projects", async () => {
    const otherPath = join(root, "other");
    await mkdir(otherPath, { recursive: true });
    const other: WorkflowProject = { id: "p2", path: otherPath, kind: "folder", missing: false };
    const one = await service.create(project, { name: "Shared", id: "shared" });
    const two = await service.create(other, { name: "Shared", id: "shared" });
    expect(one.etag).toBe(two.etag);
    await service.remove(project, "shared", one.etag);
    expect(service.listPage(other, { limit: 500 }).items).toHaveLength(1);
  });

  it("recovers its own publish-temp hard link after a crash between link and unlink", async () => {
    const document = await service.create(project, {
      name: "Crash Window",
      template: "linear-fake",
    });
    const directory = join(projectPath, ".relay", "workflows");
    const target = join(directory, `${document.workflow.id}.json`);
    await rm(target);
    const temp = join(directory, `.${document.workflow.id}.${process.pid}.${"a".repeat(16)}.tmp`);
    await writeFile(temp, document.text, { mode: 0o600 });
    await link(temp, target);
    expect((await lstat(target)).nlink).toBe(2);
    expect((await lstat(temp)).nlink).toBe(2);

    const restarted = new ManagedWorkflowService({ dataDir });
    const recovered = restarted.get(project, document.workflow.id);
    expect(recovered.text).toBe(document.text);
    expect(recovered.etag).toBe(document.etag);
    expect((await lstat(target)).nlink).toBe(1);
    await expect(lstat(temp)).rejects.toThrow();
    expect(restarted.listPage(project, { limit: 50 }).items.map((item) => item.id)).toEqual([
      document.workflow.id,
    ]);
  });

  it("still rejects generic external hard links, including reserved-looking temps", async () => {
    const outside = join(root, "outside.json");
    await writeFile(outside, JSON.stringify(linear("evil", "Evil")), "utf8");
    const directory = join(projectPath, ".relay", "workflows");
    await mkdir(directory, { recursive: true });
    await link(outside, join(directory, "evil.json"));
    const fakeTemp = join(directory, `.evil.${process.pid}.${"b".repeat(16)}.tmp`);
    await writeFile(fakeTemp, "not the same inode", { mode: 0o600 });

    expect(failureSync(() => service.get(project, "evil")).code).toBe("E_FORBIDDEN_PATH");
    expect(service.listPage(project, { limit: 50 }).items).toHaveLength(0);
    expect((await lstat(outside)).nlink).toBe(2);
  });

  it("rejects traversal ids without touching the filesystem", async () => {
    expect(failureSync(() => service.get(project, "../../etc/passwd")).code).toBe("E_VALIDATION");
    expect(failureSync(() => service.get(project, "UPPER")).code).toBe("E_VALIDATION");
  });

  it("rejects a symlinked workflow file and skips it in listings", async () => {
    const outside = join(root, "outside.json");
    await writeFile(outside, JSON.stringify(linear("evil", "Evil")), "utf8");
    const dir = join(projectPath, ".relay", "workflows");
    await mkdir(dir, { recursive: true });
    await symlink(outside, join(dir, "evil.json"));
    expect(failureSync(() => service.get(project, "evil")).code).toBe("E_FORBIDDEN_PATH");
    expect(service.listPage(project, { limit: 500 }).items).toHaveLength(0);
  });

  it("refuses a missing project root without recreating it", async () => {
    await rm(projectPath, { recursive: true, force: true });
    const error = await failure(service.create(project, { name: "Gone" }));
    expect(error.code).toBe("E_CONFLICT");
    await expect(readFile(join(projectPath, ".relay"), "utf8")).rejects.toThrow();
  });

  it("caps oversized files on read", async () => {
    const dir = join(projectPath, ".relay", "workflows");
    await mkdir(dir, { recursive: true });
    const big = "x".repeat(1024 * 1024 + 1);
    await writeFile(join(dir, "big.json"), big, "utf8");
    expect(failureSync(() => service.get(project, "big")).code).toBe("E_PAYLOAD_TOO_LARGE");
  });

  it("saves promptFile metadata but rejects it for managed runs until review covers sidecars", async () => {
    const document = await service.create(project, { name: "Prompt", template: "linear-fake" });
    const agent = document.workflow.graph.nodes.find((node) => node.type === "agent");
    if (agent === undefined || agent.type !== "agent") throw new Error("missing agent");
    const workflow: WorkflowFile = {
      ...document.workflow,
      graph: {
        ...document.workflow.graph,
        nodes: document.workflow.graph.nodes.map((node) => {
          if (node.type !== "agent" || node.id !== agent.id) return node;
          const { prompt: _prompt, ...rest } = node;
          return { ...rest, promptFile: `${document.workflow.id}.prompts/task.md` };
        }),
      },
    };
    const saved = await service.save(project, document.workflow.id, workflow, document.etag);
    expect(saved.workflow.graph.nodes.find((node) => node.id === agent.id)?.type).toBe("agent");

    const error = await failure(
      service.run(project, document.workflow.id, { params: {}, etag: saved.etag }),
    );
    expect(error.code).toBe("E_NOT_SUPPORTED");
    expect((error.details as { nodeIds?: string[] }).nodeIds).toEqual([agent.id]);
  });

  it("deletes only the definition file with a matching ETag", async () => {
    const document = await service.create(project, { name: "Delete", template: "linear-fake" });
    const stale = await failure(service.remove(project, document.workflow.id, "0".repeat(64)));
    expect(stale.code).toBe("E_CONFLICT");
    await service.remove(project, document.workflow.id, document.etag);
    expect(service.listPage(project, { limit: 500 }).items).toHaveLength(0);
    await expect(readFile(join(projectPath, document.relativeFile), "utf8")).rejects.toThrow();
  });
});

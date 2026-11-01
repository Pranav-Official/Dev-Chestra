import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const main = resolve(import.meta.dirname, "../dist/main.js");
const dirs: string[] = [];
const servers: ChildProcess[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!existsSync(main))("agent CLI lifecycle", () => {
  it("creates, starts, watches, approves, and replays a durable run", async () => {
    const root = mkdtempSync(join(tmpdir(), "devchestra-agent-e2e-"));
    dirs.push(root);
    const project = join(root, "project");
    const data = join(root, "data");
    mkdirSync(project);
    const file = join(root, "workflow.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        id: "review",
        name: "Review",
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start", params: [] },
            {
              id: "approval",
              type: "approval",
              name: "Review",
              message: "Review this",
              irreversible: false,
            },
            { id: "end", type: "end", name: "End", status: "success", result: "{}" },
          ],
          edges: [
            { id: "a", from: "start", to: "approval" },
            { id: "b", from: "approval", to: "end" },
          ],
        },
      }),
    );
    const server = spawn(
      process.execPath,
      [main, "start", "--headless", "--data-dir", data, "--port", "0"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    servers.push(server);
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error("server did not start")), 20_000);
      server.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("devchestra.ready")) {
          clearTimeout(timer);
          done();
        }
      });
      server.once("exit", () => {
        clearTimeout(timer);
        fail(new Error("server exited"));
      });
    });
    function run(...args: string[]) {
      const result = spawnSync(process.execPath, [main, ...args, "--data-dir", data], {
        encoding: "utf8",
        timeout: 15_000,
      });
      return { code: result.status, out: result.stdout, err: result.stderr };
    }
    expect(run("project", "add", project).code).toBe(0);
    expect(existsSync(join(project, ".devchestra", "skill.md"))).toBe(false);
    expect(run("workflow", "validate", "--project", project, "--file", file).code).toBe(0);
    const created = run("workflow", "create", "--project", project, "--file", file);
    expect(created.code, created.err).toBe(0);
    expect(run("workflow", "create", "--project", project, "--file", file).code).toBe(4);
    const etag = (JSON.parse(created.out) as { etag: string }).etag;
    const changed = JSON.parse(readFileSync(file, "utf8"));
    changed.name = "Updated review";
    writeFileSync(file, JSON.stringify(changed));
    expect(
      run("workflow", "update", "review", "--project", project, "--file", file, "--if-match", etag)
        .code,
    ).toBe(0);
    expect(
      run("workflow", "update", "review", "--project", project, "--file", file, "--if-match", etag)
        .code,
    ).toBe(4);
    const start = run("run", "start", "review", "--project", project, "--idempotency-key", "test");
    expect(start.code, start.err).toBe(0);
    const id = (JSON.parse(start.out) as { runId: string }).runId;
    const duplicate = run(
      "run",
      "start",
      "review",
      "--project",
      project,
      "--idempotency-key",
      "test",
    );
    expect(JSON.parse(duplicate.out)).toMatchObject({ runId: id, duplicate: true });
    const watch = run("run", "watch", id, "--timeout", "10");
    expect(watch.code, watch.err).toBe(5);
    const detail = JSON.parse(run("approval", "list", "--run", id).out).items[0];
    const args = [
      "approval",
      "resolve",
      id,
      "--path",
      detail.path,
      "--decision",
      "approve",
      "--request-id",
      detail.requestId,
      "--expected-attempt",
      String(detail.expectedAttempt),
      "--expected-generation",
      String(detail.expectedGeneration),
    ];
    const stale = [...args];
    stale[stale.indexOf("--expected-generation") + 1] = String(detail.expectedGeneration + 1);
    expect(run(...stale).code).toBe(4);
    expect(run(...args).code).toBe(0);
    const replay = run(
      "run",
      "watch",
      id,
      "--after",
      String(detail.requestEventId),
      "--timeout",
      "10",
    );
    expect(replay.code, replay.err).toBe(0);
    expect(replay.out).toContain('"type":"run.completed"');
    expect(JSON.parse(run("run", "show", id).out).view.status).toBe("succeeded");
    expect(readFileSync(file, "utf8")).toContain('"id":"review"');
    expect(run("stop", "--force").code).toBe(0);
  }, 60_000);
});

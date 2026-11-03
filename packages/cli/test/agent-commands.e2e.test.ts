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
      [main, "start", "--headless", "--foreground", "--data-dir", data, "--port", "0"],
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
    const schema = run("workflow", "schema");
    expect(schema.code, schema.err).toBe(0);
    expect(JSON.parse(schema.out)).toMatchObject({
      contractVersion: 1,
      schemaVersion: 1,
      schema: { type: "object" },
    });
    const invalidFlag = run("project", "list", "--file", file);
    expect(invalidFlag.code).toBe(4);
    expect(JSON.parse(invalidFlag.err)).toMatchObject({
      contractVersion: 1,
      error: { code: "E_VALIDATION", retryable: false },
    });
    expect(run("project", "add", project).code).toBe(0);
    expect(existsSync(join(project, ".devchestra", "skill.md"))).toBe(false);
    expect(run("workflow", "validate", "--project", project, "--file", file).code).toBe(0);
    const groupView = JSON.parse(run("workflow", "groups", "show", "--project", project).out);
    const groupFile = join(root, "groups.json");
    writeFileSync(groupFile, JSON.stringify(groupView.document));
    expect(
      run(
        "workflow",
        "groups",
        "update",
        "--project",
        project,
        "--file",
        groupFile,
        "--if-match",
        groupView.etag,
      ).code,
    ).toBe(0);
    const gateFile = join(root, "gate.json");
    writeFileSync(
      gateFile,
      JSON.stringify({
        gate: {
          id: "gate",
          type: "gate",
          name: "Gate",
          branches: [
            { id: "yes", when: "true" },
            { id: "other", otherwise: true },
          ],
        },
        scope: {},
      }),
    );
    const gate = run("gate", "test", "--project", project, "--file", gateFile);
    expect(gate.code, gate.err).toBe(0);
    expect(JSON.parse(gate.out)).toMatchObject({ contractVersion: 1, branch: "yes" });
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
    const capabilities = JSON.parse(run("capabilities").out);
    expect(
      capabilities.commands.find((command: { name: string }) => command.name === "run list").flags,
    ).toEqual(expect.arrayContaining(["workflow", "status", "archived"]));
    const matching = run(
      "run",
      "list",
      "--project",
      project,
      "--workflow",
      "review",
      "--status",
      "waiting_approval",
      "--archived",
      "false",
    );
    expect(matching.code, matching.err).toBe(0);
    expect(JSON.parse(matching.out).items.map((item: { id: string }) => item.id)).toContain(id);
    const wrongWorkflow = run("run", "list", "--project", project, "--workflow", "other");
    expect(wrongWorkflow.code, wrongWorkflow.err).toBe(0);
    expect(JSON.parse(wrongWorkflow.out).items).toHaveLength(0);
    const wrongStatus = run("run", "list", "--project", project, "--status", "failed");
    expect(wrongStatus.code, wrongStatus.err).toBe(0);
    expect(JSON.parse(wrongStatus.out).items).toHaveLength(0);
    const archived = run("run", "list", "--project", project, "--archived", "true");
    expect(archived.code, archived.err).toBe(0);
    expect(JSON.parse(archived.out).items).toHaveLength(0);
    const timeout = run("run", "watch", id, "--until", "terminal", "--timeout", "1");
    expect(timeout.code).toBe(1);
    expect(JSON.parse(timeout.err)).toMatchObject({
      contractVersion: 1,
      error: { code: "E_TIMEOUT", retryable: true },
    });
    expect(JSON.parse(run("run", "show", id).out).view.status).toBe("waiting_approval");
    const compact = run("run", "status", id);
    expect(compact.code, compact.err).toBe(0);
    expect(JSON.parse(compact.out)).toMatchObject({
      contractVersion: 1,
      runId: id,
      workflow: "review",
      status: "waiting_approval",
      nodes: { succeeded: 1, waiting: 1 },
      needsAttention: [{ type: "approval", path: "approval", message: "Review this" }],
    });
    expect(compact.out.length).toBeLessThan(1024);
    const withoutElapsed = (out: string) => ({ ...JSON.parse(out), elapsedMs: 0 });
    expect(withoutElapsed(run("run", "show", id, "--compact").out)).toEqual(
      withoutElapsed(compact.out),
    );
    expect(JSON.parse(run("run", "show", id).out)).toHaveProperty("view.executions");
    expect(run("run", "show", id, "--project", project).code).toBe(0);
    const otherProject = join(root, "other-project");
    mkdirSync(otherProject);
    expect(run("project", "add", otherProject).code).toBe(0);
    const wrongProject = run("run", "status", id, "--project", otherProject);
    expect(wrongProject.code).toBe(4);
    expect(JSON.parse(wrongProject.err).error.message).toContain("does not belong to project");
    const noPath = run("run", "execution", id);
    expect(noPath.code).toBe(4);
    expect(JSON.parse(noPath.err).error.message).toContain("find#1/discover");
    const badPath = run("run", "execution", id, "--path", "Not A Path");
    expect(badPath.code).toBe(4);
    expect(JSON.parse(badPath.err).error.message).toContain("not a valid node path");
    const badStatus = run("run", "list", "--status", "done");
    expect(badStatus.code).toBe(4);
    expect(JSON.parse(badStatus.err).error.message).toContain("waiting_approval");
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
    const firstPage = JSON.parse(run("run", "events", id, "--limit", "2").out);
    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    const nextPage = JSON.parse(
      run("run", "events", id, "--after", String(firstPage.nextAfter), "--limit", "2").out,
    );
    expect(nextPage.events[0].id).toBeGreaterThan(firstPage.events[1].id);
    expect(JSON.parse(timeout.err).error.details.lastEventId).toBeGreaterThan(0);
    expect(JSON.parse(run("run", "show", id).out).view.status).toBe("succeeded");
    const second = JSON.parse(run("run", "start", "review", "--project", project).out)
      .runId as string;
    expect(run("run", "watch", second, "--timeout", "10").code).toBe(5);
    expect(run("run", "cancel", second).code).toBe(0);
    const cancelled = run("run", "watch", second, "--timeout", "10");
    expect(cancelled.code, cancelled.err).toBe(3);
    expect(JSON.parse(run("run", "show", second).out).view.status).toBe("cancelled");
    expect(readFileSync(file, "utf8")).toContain('"id":"review"');
    expect(run("stop", "--force").code).toBe(0);
  }, 60_000);
  it("fences uncertain shell retry across server restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "devchestra-recovery-e2e-"));
    dirs.push(root);
    const project = join(root, "project"),
      data = join(root, "data"),
      file = join(root, "workflow.json");
    mkdirSync(project);
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        id: "recover",
        name: "Recover",
        graph: {
          nodes: [
            { id: "start", type: "start", name: "Start", params: [] },
            { id: "hold", type: "shell", name: "Hold", command: "sleep 2", timeoutMin: 1 },
            { id: "end", type: "end", name: "End", status: "success", result: "{}" },
          ],
          edges: [
            { id: "a", from: "start", to: "hold" },
            { id: "b", from: "hold", to: "end" },
          ],
        },
      }),
    );
    const startServer = async () => {
      const server = spawn(
        process.execPath,
        [main, "start", "--headless", "--foreground", "--data-dir", data, "--port", "0"],
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
          fail(new Error("server exited before ready"));
        });
      });
    };
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [main, ...args, "--data-dir", data], {
        encoding: "utf8",
        timeout: 20_000,
      });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    await startServer();
    expect(run("project", "add", project).code).toBe(0);
    expect(run("workflow", "create", "--project", project, "--file", file).code).toBe(0);
    const started = run("run", "start", "recover", "--project", project);
    expect(started.code, started.err).toBe(0);
    const runId = JSON.parse(started.out).runId as string;
    let active = false;
    for (let n = 0; n < 30 && !active; n++) {
      const shown = run("run", "show", runId);
      active = JSON.parse(shown.out).view.executions.hold?.status === "running";
      if (!active) await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    }
    expect(active).toBe(true);
    expect(run("stop", "--force").code).toBe(0);
    await startServer();
    const shown = JSON.parse(run("run", "show", runId).out);
    expect(shown.view).toMatchObject({ status: "paused", pauseReason: "uncertain_side_effect" });
    const execution = shown.view.executions.hold;
    expect(run("run", "resume", runId).code).toBe(4);
    const fence = [
      "run",
      "resume",
      runId,
      "--retry-uncertain-shell",
      "--path",
      "hold",
      "--expected-attempt",
      String(execution.attempt),
      "--expected-generation",
      String(execution.generation),
      "--expected-event-id",
      String(shown.watermark),
    ];
    const stale = [...fence];
    stale[stale.indexOf("--expected-generation") + 1] = String(execution.generation + 1);
    expect(run(...stale).code).toBe(4);
    const resumed = run(...fence);
    expect(resumed.code, resumed.err).toBe(0);
    const watched = run("run", "watch", runId, "--timeout", "10");
    expect(watched.code, watched.err).toBe(0);
    expect(JSON.parse(run("run", "show", runId).out).view.status).toBe("succeeded");
    expect(run("stop").code).toBe(0);
  }, 60_000);
});

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

async function startServer(data: string): Promise<void> {
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
}

describe.skipIf(!existsSync(main))("model tier settings CLI", () => {
  it("maps tiers per machine, layers the committed file, and refuses an unmapped tier", async () => {
    const root = mkdtempSync(join(tmpdir(), "devchestra-settings-e2e-"));
    dirs.push(root);
    const project = join(root, "project");
    const data = join(root, "data");
    mkdirSync(project);
    await startServer(data);
    function run(...args: string[]) {
      const result = spawnSync(process.execPath, [main, ...args, "--data-dir", data], {
        encoding: "utf8",
        timeout: 15_000,
      });
      return { code: result.status, out: result.stdout, err: result.stderr };
    }
    expect(run("project", "add", project).code).toBe(0);

    // Registration seeds this machine's mapping and keeps it out of git.
    const seeded = JSON.parse(
      readFileSync(join(project, ".devchestra/settings.local.json"), "utf8"),
    );
    expect(Object.keys(seeded.models).sort()).toEqual(["high", "low", "medium"]);
    expect(readFileSync(join(project, ".devchestra/.gitignore"), "utf8")).toContain(
      "settings.local.json",
    );
    const starter = readFileSync(join(project, ".devchestra/workflows/project-tour.json"), "utf8");
    expect(starter).toContain('"tier": "medium"');

    const set = run("settings", "set", "high", "claude-code", "opus", "--project", project);
    expect(set.code, set.err).toBe(0);
    expect(JSON.parse(set.out)).toMatchObject({
      scope: "local",
      document: { models: { high: { cli: "claude-code", model: "opus" } } },
    });

    const team = run("settings", "set", "low", "pi", "--scope", "project", "--project", project);
    expect(team.code, team.err).toBe(0);
    expect(existsSync(join(project, ".devchestra/settings.json"))).toBe(true);

    const effective = JSON.parse(run("settings", "show", "--project", project).out);
    expect(effective.tiers[0]).toEqual({
      tier: "high",
      mapping: { ref: { cli: "claude-code", model: "opus" }, source: "local" },
    });
    expect(effective.tiers[2]).toMatchObject({ tier: "low", mapping: { source: "local" } });

    expect(run("settings", "unset", "low", "--project", project).code).toBe(0);
    const afterUnset = JSON.parse(run("settings", "show", "--project", project).out);
    expect(afterUnset.tiers[2]).toEqual({
      tier: "low",
      mapping: { ref: { cli: "pi" }, source: "project" },
    });

    const bad = run("settings", "set", "ultra", "pi", "--project", project);
    expect(bad.code).toBe(4);
    expect(run("settings", "set", "high", "fake", "--project", project).code).toBe(4);

    // Clearing the mapping makes a tiered run refuse up front, naming the tier to set.
    for (const tier of ["high", "medium", "low"]) {
      run("settings", "unset", tier, "--project", project);
      run("settings", "unset", tier, "--scope", "project", "--project", project);
    }
    const refused = run("run", "start", "project-tour", "--project", project);
    expect(refused.code).toBe(4);
    expect(JSON.parse(refused.err)).toMatchObject({
      error: { code: "E_MODEL_TIER" },
    });
    expect(refused.err).toContain("devchestra settings set");
  });
});

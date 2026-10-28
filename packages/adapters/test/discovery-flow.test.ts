import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverOpencodeModels,
  discoverPiModels,
  type OpencodeModelDiscoveryRequest,
  type PiModelDiscoveryRequest,
} from "../src/index.js";
import { FIXTURES } from "./helpers.js";

const PI_STUB = fileURLToPath(new URL("./stubs/pi-cli.mjs", import.meta.url));
const OPENCODE_STANDIN = resolve(FIXTURES, "..", "opencode", "standin.mjs");
const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function mkTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function piBin(
  dir: string,
  scenario: Record<string, unknown>,
): Promise<{ bin: string; req: (extra?: Partial<PiModelDiscoveryRequest>) => PiModelDiscoveryRequest }> {
  const bin = join(dir, "pi-stub.mjs");
  await copyFile(PI_STUB, bin);
  await chmod(bin, 0o755);
  const logPath = join(dir, "calls.log");
  return {
    bin,
    req: (extra = {}) => ({
      cwd: dir,
      bin,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: "/nonexistent-home",
        STUB_LOG: logPath,
        STUB_SCENARIO_JSON: JSON.stringify(scenario),
      },
      timeoutMs: 5_000,
      ...extra,
    }),
  };
}

async function opencodeBin(
  dir: string,
  scenario: Record<string, unknown>,
): Promise<{ bin: string; req: (extra?: Partial<OpencodeModelDiscoveryRequest>) => OpencodeModelDiscoveryRequest }> {
  const bin = join(dir, "opencode-standin.mjs");
  await copyFile(OPENCODE_STANDIN, bin);
  await chmod(bin, 0o755);
  const scenarioPath = join(dir, "scenario.json");
  await writeFile(scenarioPath, JSON.stringify(scenario));
  const home = join(dir, "home");
  return {
    bin,
    req: (extra = {}) => ({
      cwd: dir,
      bin,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        STUB_SCENARIO: scenarioPath,
        STUB_LOG: join(dir, "calls.log"),
      },
      timeoutMs: 5_000,
      ...extra,
    }),
  };
}

async function sleeperBin(dir: string, name: string): Promise<string> {
  const bin = join(dir, name);
  await writeFile(bin, '#!/usr/bin/env node\nawait new Promise((r) => setTimeout(r, 5000));\n');
  await chmod(bin, 0o755);
  return bin;
}

const PI_TABLE =
  "provider      model         context  max-out  thinking  images\nopencode-go   kimi-k3       1.0M     131.1K   yes       yes   \n";

describe("pi discovery flow characterization", () => {
  it("success returns ready items with cli version", async () => {
    const dir = await mkTemp("relay-pi-flow-");
    const { req } = await piBin(dir, { table: PI_TABLE });
    const result = await discoverPiModels(req());
    expect(result.status).toBe("ready");
    expect(result.cliVersion).toBe("1.4.0");
    expect(result.truncated).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("opencode-go/kimi-k3");
    expect(result.message).toBeUndefined();
  });

  it("timeout maps to unavailable with the pi timeout message", async () => {
    const dir = await mkTemp("relay-pi-flow-");
    const { req } = await piBin(dir, { delayMs: 5000, table: PI_TABLE });
    const result = await discoverPiModels(req({ timeoutMs: 300 }));
    expect(result.status).toBe("unavailable");
    expect(result.message).toBe("Pi model discovery timed out.");
    expect(result.items).toEqual([]);
  });

  it("oversized output is tailed, not failed: ready with fewer items", async () => {
    const dir = await mkTemp("relay-pi-flow-");
    const rows = Array.from({ length: 20 }, (_, i) => `opencode-go   m${i}   1M   1K   yes   no`).join(
      "\n",
    );
    const { req } = await piBin(dir, { table: `provider model\n${rows}\n` });
    const result = await discoverPiModels(req({ maxStdoutBytes: 200 }));
    expect(result.status).toBe("ready");
    expect(result.message).toBeUndefined();
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.length).toBeLessThan(20);
  });

  it("nonzero exit with parseable rows still returns ready", async () => {
    const dir = await mkTemp("relay-pi-flow-");
    const { req } = await piBin(dir, { table: PI_TABLE, exitCode: 1 });
    const result = await discoverPiModels(req());
    expect(result.status).toBe("ready");
    expect(result.items).toHaveLength(1);
  });

  it("nonzero exit with empty output returns unavailable", async () => {
    const dir = await mkTemp("relay-pi-flow-");
    const { req } = await piBin(dir, { table: "", exitCode: 1, stderr: "boom" });
    const result = await discoverPiModels(req());
    expect(result.status).toBe("unavailable");
    expect(result.message).toBe("Pi model discovery is unavailable.");
    expect(result.items).toEqual([]);
  });

  it("malformed table returns ready with no items and truncated", async () => {
    const dir = await mkTemp("relay-pi-flow-");
    const { req } = await piBin(dir, { table: "not a table at all\nanother bad line\n" });
    const result = await discoverPiModels(req());
    expect(result.status).toBe("ready");
    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it("pre-aborted signal returns invalid-request, not cancelled", async () => {
    const dir = await mkTemp("relay-pi-flow-");
    const { req } = await piBin(dir, { table: PI_TABLE });
    const controller = new AbortController();
    controller.abort();
    const result = await discoverPiModels(req({ signal: controller.signal }));
    expect(result.status).toBe("unavailable");
    expect(result.message).toBe("Invalid model discovery request.");
  });

  it("invalid requests fail without items: NUL cwd, oversize bin, dash search", async () => {
    const dir = await mkTemp("relay-pi-flow-");
    const { req } = await piBin(dir, { table: PI_TABLE });
    for (const extra of [
      { cwd: "/wo\0rk" },
      { bin: `/${"b".repeat(4096)}` },
      { search: "--help" },
      { search: "s".repeat(257) },
    ]) {
      const result = await discoverPiModels(req(extra));
      expect(result.status).toBe("unavailable");
      expect(result.message).toBe("Invalid model discovery request.");
    }
  });
});

describe("opencode discovery flow characterization", () => {
  it("success returns ready items with null cli version", async () => {
    const dir = await mkTemp("relay-oc-flow-");
    const { req } = await opencodeBin(dir, { models: ["opencode/gpt-5"] });
    const result = await discoverOpencodeModels(req());
    expect(result.status).toBe("ready");
    expect(result.cliVersion).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.items).toEqual([
      { id: "opencode/gpt-5", label: "opencode/gpt-5", provider: "opencode", source: "opencode-models" },
    ]);
    expect(result.message).toBeUndefined();
  });

  it("timeout maps to unavailable with the opencode timeout message", async () => {
    const dir = await mkTemp("relay-oc-flow-");
    const bin = await sleeperBin(dir, "sleeper.mjs");
    const result = await discoverOpencodeModels({
      cwd: dir,
      bin,
      env: { PATH: "/usr/bin:/bin", HOME: join(dir, "home") },
      timeoutMs: 300,
    });
    expect(result.status).toBe("unavailable");
    expect(result.message).toBe("Opencode model discovery timed out.");
    expect(result.items).toEqual([]);
  });

  it("oversized output fails unavailable with the oversize message", async () => {
    const dir = await mkTemp("relay-oc-flow-");
    const { req } = await opencodeBin(dir, { models: [`opencode/${"x".repeat(200)}`] });
    const result = await discoverOpencodeModels(req({ maxStdoutBytes: 64 }));
    expect(result.status).toBe("unavailable");
    expect(result.message).toBe("Opencode model output exceeded safe limits.");
    expect(result.items).toEqual([]);
  });

  it("nonzero exit with parseable lines still returns ready", async () => {
    const dir = await mkTemp("relay-oc-flow-");
    const { req } = await opencodeBin(dir, { models: ["a/one"], exitCode: 1 });
    const result = await discoverOpencodeModels(req());
    expect(result.status).toBe("ready");
    expect(result.items.map((item) => item.id)).toEqual(["a/one"]);
  });

  it("nonzero exit with empty output returns unavailable", async () => {
    const dir = await mkTemp("relay-oc-flow-");
    const { req } = await opencodeBin(dir, { exitCode: 1, stderr: "boom" });
    const result = await discoverOpencodeModels(req());
    expect(result.status).toBe("unavailable");
    expect(result.message).toBe("Opencode model discovery is unavailable.");
    expect(result.items).toEqual([]);
  });

  it("malformed lines return ready with parsed items and truncated", async () => {
    const dir = await mkTemp("relay-oc-flow-");
    // A non-id line with no pending id marks truncation; a non-id line
    // after an id is probed as verbose `name` metadata and ignored.
    const { req } = await opencodeBin(dir, { models: ["not an id at all", "ok/one", "ok/two"] });
    const result = await discoverOpencodeModels(req());
    expect(result.status).toBe("ready");
    expect(result.items.map((item) => item.id)).toEqual(["ok/one", "ok/two"]);
    expect(result.truncated).toBe(true);
  });

  it("pre-aborted signal returns cancelled", async () => {
    const dir = await mkTemp("relay-oc-flow-");
    const { req } = await opencodeBin(dir, { models: ["opencode/gpt-5"] });
    const controller = new AbortController();
    controller.abort();
    const result = await discoverOpencodeModels(req({ signal: controller.signal }));
    expect(result.status).toBe("unavailable");
    expect(result.message).toBe("Opencode model discovery was cancelled.");
  });

  it("invalid requests fail without items: NUL cwd, oversize bin", async () => {
    const dir = await mkTemp("relay-oc-flow-");
    const { req } = await opencodeBin(dir, { models: ["opencode/gpt-5"] });
    for (const extra of [{ cwd: "/wo\0rk" }, { bin: `/${"b".repeat(4096)}` }]) {
      const result = await discoverOpencodeModels(req(extra));
      expect(result.status).toBe("unavailable");
      expect(result.message).toBe("Invalid model discovery request.");
    }
  });

  it("missing binary maps to the opencode missing message", async () => {
    const dir = await mkTemp("relay-oc-flow-");
    const result = await discoverOpencodeModels({
      cwd: dir,
      bin: join(dir, "no-such-binary"),
      env: { PATH: "/usr/bin:/bin", HOME: join(dir, "home") },
      timeoutMs: 2_000,
    });
    expect(result.status).toBe("unavailable");
    expect(result.message).toBe("Opencode CLI was not found.");
  });
});

import { describe, expect, it } from "vitest";
import {
  boundCount,
  boundMs,
  type CodexModelDiscoveryRequest,
  discoverCodexModels,
  type DiscoveryRequestFields,
  discoverOpencodeModels,
  discoverPiModels,
  hasControl,
  type OpencodeModelDiscoveryRequest,
  type PiModelDiscoveryRequest,
  printable,
  validateDiscoveryRequest,
} from "../src/index.js";

const BASE: DiscoveryRequestFields = {
  cwd: "/work",
  env: { PATH: "/usr/bin:/bin" },
};

const CASES: { name: string; request: DiscoveryRequestFields }[] = [
  { name: "empty cwd", request: { ...BASE, cwd: "" } },
  { name: "cwd with NUL", request: { ...BASE, cwd: "/wo\0rk" } },
  { name: "empty bin", request: { ...BASE, bin: "" } },
  { name: "bin with NUL", request: { ...BASE, bin: "/bin/pi\0x" } },
  { name: "oversize bin", request: { ...BASE, bin: `/${"b".repeat(4096)}` } },
  { name: "null env", request: { ...BASE, env: null } },
  { name: "array env", request: { ...BASE, env: [] } },
  { name: "empty env name", request: { ...BASE, env: { "": "x" } } },
  { name: "env name with =", request: { ...BASE, env: { "A=B": "x" } } },
  { name: "env name with NUL", request: { ...BASE, env: { "A\0": "x" } } },
  { name: "non-string env value", request: { ...BASE, env: { A: 1 } } },
  { name: "env value with NUL", request: { ...BASE, env: { A: "x\0y" } } },
  { name: "empty search", request: { ...BASE, search: "" } },
  { name: "oversize search", request: { ...BASE, search: "s".repeat(257) } },
  { name: "search with NUL", request: { ...BASE, search: "a\0b" } },
  { name: "search with leading -", request: { ...BASE, search: "--version" } },
];

describe("validateDiscoveryRequest", () => {
  it("accepts a minimal valid request", () => {
    expect(validateDiscoveryRequest(BASE)).toBe(true);
  });

  it("accepts a valid request with bin and search", () => {
    expect(validateDiscoveryRequest({ ...BASE, bin: "/bin/pi", search: "kimi" })).toBe(true);
  });

  it.each(CASES)("rejects $name", ({ request }) => {
    expect(validateDiscoveryRequest(request)).toBe(false);
  });
});

describe("shared discovery helpers", () => {
  it.each(["a\nb", "a\x01b", "a\x7fb", "a\0b"])("hasControl detects %j", (value) => {
    expect(hasControl(value)).toBe(true);
  });

  it.each(["plain", "provider/model", "kimi-k3-0804"])("hasControl accepts %j", (value) => {
    expect(hasControl(value)).toBe(false);
  });

  it("printable blanks control characters and collapses whitespace", () => {
    expect(printable("a\x01\x7fb")).toBe("a b");
    expect(printable("  a   b  ")).toBe("a b");
  });

  it("boundMs clamps to [1, fallback]", () => {
    expect(boundMs(undefined, 100)).toBe(100);
    expect(boundMs(Number.NaN, 100)).toBe(100);
    expect(boundMs(0, 100)).toBe(1);
    expect(boundMs(10.9, 100)).toBe(10);
    expect(boundMs(10_000, 100)).toBe(100);
  });

  it("boundCount clamps to [1, fallback]", () => {
    expect(boundCount(undefined, 100)).toBe(100);
    expect(boundCount(Number.POSITIVE_INFINITY, 100)).toBe(100);
    expect(boundCount(-5, 100)).toBe(1);
    expect(boundCount(10_000, 100)).toBe(100);
  });
});

describe("discovery entry points reject invalid requests", () => {
  it.each(CASES)("pi rejects $name without spawning", async ({ request }) => {
    const result = await discoverPiModels(request as PiModelDiscoveryRequest);
    expect(result.status).toBe("unavailable");
    expect(result.message).toMatch(/Invalid model discovery request/);
    expect(result.items).toEqual([]);
  });

  it.each(CASES)("opencode rejects $name without spawning", async ({ request }) => {
    const result = await discoverOpencodeModels(request as OpencodeModelDiscoveryRequest);
    expect(result.status).toBe("unavailable");
    expect(result.message).toMatch(/Invalid model discovery request/);
    expect(result.items).toEqual([]);
  });

  it.each(CASES)("codex rejects $name without spawning", async ({ request }) => {
    const result = await discoverCodexModels(request as CodexModelDiscoveryRequest);
    expect(result.status).toBe("unavailable");
    expect(result.message).toMatch(/Invalid model discovery request/);
    expect(result.items).toEqual([]);
  });
});

import { tmpdir } from "node:os";
import { createExecutionIdentity, type Path, type RunId } from "@devchestra/core";
import { describe, expect, it, vi } from "vitest";
import { type ExecScope, ExecTokenRegistry } from "../src/tokens.js";

const identity = createExecutionIdentity("run-1" as RunId, "research" as Path, 1, 2);
const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
} as const;

function scope(overrides: Partial<ExecScope> = {}): ExecScope {
  return {
    identity,
    toolset: "agent",
    outputSchema: schema as unknown as Record<string, unknown>,
    outputSchemaHash: "hash",
    validationLimit: 3,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe("ExecTokenRegistry", () => {
  it("freezes a cloned scope so caller mutation cannot change authorization", () => {
    const input = scope();
    const registry = new ExecTokenRegistry();
    const token = registry.issue(input);

    (input.identity as { attempt: number }).attempt = 99;
    (
      (input.outputSchema.properties as Record<string, unknown>).answer as Record<string, unknown>
    ).type = "number";

    const resolved = registry.resolve(token);
    expect(resolved).not.toBeNull();
    if (resolved === null) {
      throw new Error("token did not resolve");
    }
    const resolvedScope: ExecScope = resolved;
    expect(resolvedScope.identity.attempt).toBe(1);
    expect(resolvedScope.identity.generation).toBe(2);
    const properties = resolvedScope.outputSchema.properties as Record<string, unknown>;
    const answer = properties.answer as Record<string, unknown>;
    expect(answer.type).toBe("string");
    expect(Object.isFrozen(resolvedScope)).toBe(true);
    expect(Object.isFrozen(resolvedScope.identity)).toBe(true);
    expect(Object.isFrozen(resolvedScope.outputSchema)).toBe(true);
  });

  it("rejects invalid expiry, toolset and identity at issue time", () => {
    const registry = new ExecTokenRegistry();
    expect(() => registry.issue(scope({ expiresAt: Number.NaN }))).toThrow();
    expect(() => registry.issue(scope({ expiresAt: Date.now() - 1 }))).toThrow();
    expect(() => registry.issue(scope({ toolset: "other" as never }))).toThrow();
    expect(() => registry.issue(scope({ identity: { ...identity, generation: 0 } }))).toThrow();
    expect(() => registry.issue(scope({ validationLimit: 0 }))).toThrow();
  });

  it("registers and releases the bearer with the injected secret hook", () => {
    const registered: string[] = [];
    const released: string[] = [];
    const registry = new ExecTokenRegistry({
      registerSecret: (token) => {
        registered.push(token);
        return () => {
          released.push(token);
        };
      },
    });
    const token = registry.issue(scope());
    expect(registered).toEqual([token]);

    expect(registry.revoke(token)).toBe(true);
    expect(released).toEqual([token]);
    expect(registry.resolve(token)).toBeNull();
  });

  it("releases the secret when a token expires", () => {
    const released: string[] = [];
    const registry = new ExecTokenRegistry({
      registerSecret: (token) => () => {
        released.push(token);
      },
    });
    const token = registry.issue(scope({ expiresAt: Date.now() + 1_000 }));
    expect(registry.resolve(token, Date.now() + 5_000)).toBeNull();
    expect(released).toEqual([token]);
  });
});

describe("execution call receipts", () => {
  const now = () => Date.now();
  function commandScope() {
    return scope({
      shell: {
        policy: {},
        cwd: tmpdir(),
        env: {},
        timeoutMs: 1000,
        maxOutputBytes: 1024,
      },
    });
  }

  it("rejects oversized UTF-8 commands before claiming an ID or starting a job", async () => {
    const registry = new ExecTokenRegistry();
    const token = registry.issue(commandScope());
    const run = vi.fn(async () => ({ text: "ok", isError: false }));
    expect(() => registry.execute(token, "id", "é".repeat(2100), run, now())).toThrowError(
      expect.objectContaining({ code: "E_PAYLOAD_TOO_LARGE" }),
    );
    expect(run).not.toHaveBeenCalled();
    await registry.execute(token, "id", "echo ok", run, now());
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reserves the worst-case output before starting concurrent commands", async () => {
    const registry = new ExecTokenRegistry({ receiptMaxBytes: 100_000 });
    const token = registry.issue(commandScope());
    let resolve: (value: { text: string; isError: boolean }) => void = () => undefined;
    const first = registry.execute(
      token,
      "one",
      "echo one",
      () =>
        new Promise((done) => {
          resolve = done;
        }),
      now(),
    );
    const run = vi.fn(async () => ({ text: "two", isError: false }));
    expect(() => registry.execute(token, "two", "echo two", run, now())).toThrowError(
      expect.objectContaining({ code: "E_FORBIDDEN" }),
    );
    expect(run).not.toHaveBeenCalled();
    expect(registry.execute(token, "one", "echo one", run, now())).toBe(first);
    await Promise.resolve();
    resolve({ text: "one", isError: false });
    await first;
    await registry.execute(token, "two", "echo two", run, now());
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("counts completed UTF-8 results against the budget while preserving exact retries", async () => {
    const registry = new ExecTokenRegistry({ receiptMaxBytes: 200_000 });
    const input = commandScope();
    if (!input.shell) throw new Error("Missing scope");
    input.shell.maxOutputBytes = 32768;
    const token = registry.issue(input);
    const run = vi.fn(async () => ({ text: "🙂".repeat(15000), isError: false }));
    const first = await registry.execute(token, "one", "echo one", run, now());
    await registry.execute(token, "two", "echo two", run, now());
    expect(() => registry.execute(token, "three", "echo three", run, now())).toThrowError(
      expect.objectContaining({ code: "E_FORBIDDEN" }),
    );
    expect(await registry.execute(token, "one", "echo one", run, now())).toEqual(first);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("bounds an unexpected oversized runner result and never reruns it", async () => {
    const registry = new ExecTokenRegistry({ receiptMaxBytes: 100_000 });
    const token = registry.issue(commandScope());
    const run = vi.fn(async () => ({ text: "x".repeat(200_000), isError: false }));
    const result = await registry.execute(token, "one", "echo one", run, now());
    expect(result.isError).toBe(true);
    expect(result.text).toContain("exceeded the receipt limit");
    expect(result.text.length).toBeLessThan(200);
    expect(await registry.execute(token, "one", "echo one", run, now())).toEqual(result);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("releases output reservations on failure and caches only a bounded error", async () => {
    const registry = new ExecTokenRegistry({ receiptMaxBytes: 100_000 });
    const token = registry.issue(commandScope());
    const run = vi.fn(async () => {
      throw new Error("x".repeat(200_000));
    });
    await expect(registry.execute(token, "one", "echo one", run, now())).rejects.toMatchObject({
      code: "E_INTERNAL",
      message: "Command execution failed.",
    });
    await expect(registry.execute(token, "one", "echo one", run, now())).rejects.toMatchObject({
      code: "E_INTERNAL",
    });
    expect(run).toHaveBeenCalledTimes(1);
    await expect(
      registry.execute(
        token,
        "two",
        "echo two",
        async () => ({ text: "ok", isError: false }),
        now(),
      ),
    ).resolves.toMatchObject({ text: "ok" });
  });

  it("fingerprints tool names and arguments in one shared namespace", async () => {
    const registry = new ExecTokenRegistry();
    const token = registry.issue(commandScope());
    registry.claimSubmission(token, "submit-first", { answer: "ok", extra: 1 }, now());
    registry.claimSubmission(token, "submit-first", { extra: 1, answer: "ok" }, now());
    expect(() =>
      registry.claimSubmission(token, "submit-first", { answer: "changed" }, now()),
    ).toThrowError(expect.objectContaining({ code: "E_CONFLICT" }));
    const run = vi.fn(async () => ({ text: "ok", isError: false }));
    expect(() => registry.execute(token, "submit-first", "echo ok", run, now())).toThrowError(
      expect.objectContaining({ code: "E_CONFLICT" }),
    );
    expect(run).not.toHaveBeenCalled();
    await registry.execute(token, "exec-first", "echo ok", run, now());
    expect(() =>
      registry.claimSubmission(token, "exec-first", { answer: "ok" }, now()),
    ).toThrowError(expect.objectContaining({ code: "E_CONFLICT" }));
  });

  it("shares receipts and reservations across tokens for the same execution identity", async () => {
    const registry = new ExecTokenRegistry({ receiptMaxBytes: 100_000 });
    const token = registry.issue(commandScope());
    const other = registry.issue(commandScope());
    let resolve: (value: { text: string; isError: boolean }) => void = () => undefined;
    const first = registry.execute(
      token,
      "one",
      "echo one",
      () =>
        new Promise((done) => {
          resolve = done;
        }),
      now(),
    );
    const run = vi.fn(async () => ({ text: "ok", isError: false }));
    expect(registry.execute(other, "one", "echo one", run, now())).toBe(first);
    expect(() => registry.execute(other, "two", "echo two", run, now())).toThrowError(
      expect.objectContaining({ code: "E_FORBIDDEN" }),
    );
    expect(() => registry.claimSubmission(other, "one", { answer: "ok" }, now())).toThrowError(
      expect.objectContaining({ code: "E_CONFLICT" }),
    );
    await Promise.resolve();
    resolve({ text: "one", isError: false });
    await first;
    registry.revoke(token);
    expect(await registry.execute(other, "one", "echo one", run, now())).toMatchObject({
      text: "one",
    });
    expect(run).not.toHaveBeenCalled();
    registry.revoke(other);
  });

  it("keeps call IDs independent across execution generations", async () => {
    const registry = new ExecTokenRegistry();
    const input = commandScope();
    const token = registry.issue(input);
    const other = registry.issue({
      ...input,
      identity: { ...input.identity, generation: input.identity.generation + 1 },
    });
    registry.claimSubmission(token, "same-id", { answer: "ok" }, now());
    await expect(
      registry.execute(
        other,
        "same-id",
        "echo ok",
        async () => ({ text: "ok", isError: false }),
        now(),
      ),
    ).resolves.toMatchObject({ text: "ok" });
  });
});

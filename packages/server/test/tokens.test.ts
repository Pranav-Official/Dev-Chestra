import { createExecutionIdentity, type Path, type RunId } from "@devchestra/core";
import { describe, expect, it } from "vitest";
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

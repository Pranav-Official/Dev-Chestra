import { describe, expect, it } from "vitest";
import {
  buildContextBlock,
  freezeContextPools,
  readContextAccess,
  readContextPools,
} from "../src/context-pool.js";

describe("context pools", () => {
  it("freezes project and workflow pools into the snapshot", () => {
    const snapshot = {
      id: "wf",
      context: [{ key: "w", value: "workflow note" }],
      graph: { nodes: [], edges: [] },
    };
    const frozen = freezeContextPools(snapshot, [{ key: "p", value: "project note" }]) as {
      contextPools: { project: unknown[]; workflow: unknown[] };
    };
    expect(readContextPools(frozen)).toEqual({
      project: [{ key: "p", value: "project note" }],
      workflow: [{ key: "w", value: "workflow note" }],
    });
    // Legacy shapes still resolve.
    expect(readContextPools({ context: [{ key: "w", value: "1" }] })).toEqual({
      project: [],
      workflow: [{ key: "w", value: "1" }],
    });
    expect(readContextPools({ graph: {} })).toEqual({ project: [], workflow: [] });
  });

  it("reads node access with none defaults", () => {
    expect(readContextAccess({})).toEqual({ project: "none", workflow: "none", execution: "none" });
    expect(
      readContextAccess({ context: { project: "read", workflow: "read", execution: "readwrite" } }),
    ).toEqual({ project: "read", workflow: "read", execution: "readwrite" });
    expect(readContextAccess({ context: { project: "readwrite" } })).toEqual({
      project: "none",
      workflow: "none",
      execution: "none",
    });
  });

  it("builds a block with only the readable sections", () => {
    const pools = {
      project: [{ key: "stack", value: "node20" }],
      workflow: [{ key: "goal", value: "ship it" }],
    };
    const execution = [
      {
        runId: "r" as never,
        key: "finding",
        value: "api is slow",
        updatedByPath: "a",
        updatedAt: 1,
        version: 1,
      },
    ];
    const full = buildContextBlock(pools, execution, {
      project: "read",
      workflow: "read",
      execution: "readwrite",
    });
    expect(full).toContain("[project]");
    expect(full).toContain("stack: node20");
    expect(full).toContain("[workflow]");
    expect(full).toContain("[execution]");
    expect(full).toContain("finding: api is slow");

    const projectOnly = buildContextBlock(pools, execution, {
      project: "read",
      workflow: "none",
      execution: "none",
    });
    expect(projectOnly).toContain("[project]");
    expect(projectOnly).not.toContain("[workflow]");
    expect(projectOnly).not.toContain("[execution]");
    expect(projectOnly).not.toContain("api is slow");

    expect(
      buildContextBlock(pools, execution, { project: "none", workflow: "none", execution: "none" }),
    ).toBe("");
    expect(
      buildContextBlock({ project: [], workflow: [] }, [], {
        project: "read",
        workflow: "read",
        execution: "read",
      }),
    ).toBe("");
  });
});

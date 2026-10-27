import { describe, expect, it } from "vitest";
import {
  ApiClient,
  runWorkspaceSelectionSchema,
  startRunRequestSchema,
  startWorkflowRunRequestSchema,
} from "../src/index.js";

interface Call {
  url: string;
  init: RequestInit;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Relay-Api": "1" },
  });
}

function makeClient(factory: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: Call = { url, init: init ?? {} };
    calls.push(call);
    return factory(call);
  }) as unknown as typeof fetch;
  return { client: new ApiClient({ baseUrl: "http://127.0.0.1:4821", fetch: fetchImpl }), calls };
}

describe("run workspace contract", () => {
  it("accepts the three workspace modes and rejects unknown fields", () => {
    expect(runWorkspaceSelectionSchema.parse({ mode: "project" })).toEqual({ mode: "project" });
    expect(runWorkspaceSelectionSchema.parse({ mode: "new-worktree" })).toEqual({
      mode: "new-worktree",
    });
    expect(
      runWorkspaceSelectionSchema.parse({ mode: "existing-worktree", path: "/tmp/wt" }),
    ).toEqual({ mode: "existing-worktree", path: "/tmp/wt" });
    expect(() =>
      runWorkspaceSelectionSchema.parse({ mode: "existing-worktree", path: "" }),
    ).toThrow();
    expect(() => runWorkspaceSelectionSchema.parse({ mode: "scratch" })).toThrow();
    expect(() =>
      runWorkspaceSelectionSchema.parse({ mode: "project", projectRoot: "/tmp/p" }),
    ).toThrow();
  });

  it("adds an optional flat workspace to both start-run request bodies", () => {
    expect(
      startRunRequestSchema.parse({ workflowFile: "flow.json", workspace: { mode: "project" } }),
    ).toMatchObject({ workspace: { mode: "project" } });
    expect(startRunRequestSchema.parse({ workflowFile: "flow.json" }).workspace).toBeUndefined();
    expect(() =>
      startRunRequestSchema.parse({
        workflowFile: "flow.json",
        workspace: { selection: { mode: "project" } },
      }),
    ).toThrow();

    expect(
      startWorkflowRunRequestSchema.parse({
        etag: "abc",
        workspace: { mode: "existing-worktree", path: "/tmp/wt" },
      }),
    ).toMatchObject({ workspace: { mode: "existing-worktree", path: "/tmp/wt" } });
    expect(startWorkflowRunRequestSchema.parse({ etag: "abc" }).workspace).toBeUndefined();
  });

  it("lists the project worktree catalog through the typed client", async () => {
    const body = {
      projectRoot: "/tmp/project",
      worktrees: [
        { path: "/tmp/project-wt", branch: "feature", head: "a".repeat(40), detached: false },
      ],
      git: true,
    };
    const { client, calls } = makeClient(() => response(body));
    await expect(client.listProjectWorkspaces("proj-1")).resolves.toEqual(body);
    expect(calls[0]?.url).toBe("http://127.0.0.1:4821/api/projects/proj-1/workspaces");
    expect(calls[0]?.init.method).toBe("GET");
  });
});

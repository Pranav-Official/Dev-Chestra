import { describe, expect, it } from "vitest";
import {
  normalizeWorkflow,
  parseWebhookPath,
  parseWorkflow,
  resolveWebhookParams,
  validateWebhookConfig,
  validateWorkflow,
  type WorkflowParam,
} from "../src/index.js";

const PARAMS: WorkflowParam[] = [
  { name: "title", type: "string", required: true },
  { name: "count", type: "number", required: false, default: 1 },
  { name: "event", type: "string", required: false, default: "none" },
];

function startNode(webhook?: unknown) {
  return {
    id: "start",
    type: "start",
    name: "Start",
    params: PARAMS,
    ...(webhook === undefined ? {} : { webhook }),
  } as never;
}

function workflow(start: unknown) {
  return {
    schemaVersion: 1,
    id: "hooked",
    name: "Hooked",
    graph: {
      nodes: [start, { id: "end", type: "end", name: "End", status: "success", result: "{}" }],
      edges: [{ id: "e0", from: "start", to: "end" }],
    },
  };
}

describe("parseWebhookPath", () => {
  it.each([
    "body.title",
    "body.issue.title",
    "body.items.0.name",
    "headers.x-github-event",
    "headers.content-type",
  ])("accepts %s", (path) => {
    expect(parseWebhookPath(path)).not.toBeNull();
  });

  it.each([
    "",
    "body",
    "body.",
    "body..title",
    "body.__proto__",
    "body.constructor.name",
    "body.a b",
    "headers.authorization",
    "headers.cookie",
    "headers.x-hub-signature-256",
    "headers.X-GitHub-Event",
    "query.page",
    "body.a.b.c.d.e.f.g.h.i",
  ])("rejects %s", (path) => {
    expect(parseWebhookPath(path)).toBeNull();
  });
});

describe("validateWebhookConfig", () => {
  it("accepts a mapping of declared parameters to allowed paths", () => {
    const issues = validateWebhookConfig(
      {
        params: PARAMS,
        webhook: { paramMapping: { title: "body.issue.title", event: "headers.x-github-event" } },
      },
      "/graph/nodes/0",
    );
    expect(issues).toEqual([]);
  });

  it("reports undeclared targets and bad or forbidden paths", () => {
    const issues = validateWebhookConfig(
      {
        params: PARAMS,
        webhook: {
          paramMapping: {
            missing: "body.title",
            title: "headers.authorization",
            count: "body..bad",
          },
        },
      },
      "/graph/nodes/0",
    );
    expect(issues.map((issue) => issue.code)).toEqual([
      "E_WEBHOOK_MAPPING",
      "E_WEBHOOK_PATH",
      "E_WEBHOOK_PATH",
    ]);
    expect(issues[0]?.pointer).toBe("/graph/nodes/0/paramMapping/missing");
  });
});

describe("resolveWebhookParams", () => {
  it("copies declared body keys when no mapping is configured and ignores the rest", () => {
    const result = resolveWebhookParams(startNode(), {
      body: { title: "Fix", count: 3, unrelated: { deep: true } },
      headers: {},
    });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ title: "Fix", count: 3, event: "none" });
  });

  it("reads mapped body paths and allowlisted headers", () => {
    const node = startNode({
      enabled: true,
      paramMapping: {
        title: "body.issue.title",
        count: "body.items.1",
        event: "headers.x-github-event",
      },
    });
    const result = resolveWebhookParams(node, {
      body: { issue: { title: "Crash" }, items: [7, 8] },
      headers: { "x-github-event": "issues" },
    });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ title: "Crash", count: 8, event: "issues" });
  });

  it("treats a mapping as authoritative: unmapped parameters fall back to defaults", () => {
    const node = startNode({ enabled: true, paramMapping: { title: "body.title" } });
    const result = resolveWebhookParams(node, { body: { title: "T", count: 9 }, headers: {} });
    expect(result.value).toEqual({ title: "T", count: 1, event: "none" });
  });

  it("reports a missing required value and never reads non-allowlisted headers", () => {
    const node = startNode({ enabled: true, paramMapping: { title: "headers.user-agent" } });
    const missing = resolveWebhookParams(node, { body: {}, headers: {} });
    expect(missing.ok).toBe(false);
    expect(missing.errors.map((error) => error.code)).toContain("E_PARAM_MISSING");

    const forbidden = resolveWebhookParams(
      startNode({ enabled: true, paramMapping: { title: "headers.authorization" } }),
      { body: {}, headers: { authorization: "Bearer secret" } },
    );
    expect(forbidden.ok).toBe(false);
    expect(JSON.stringify(forbidden)).not.toContain("secret");
  });

  it("treats null as absent and rejects objects where a string is declared", () => {
    const nulled = resolveWebhookParams(
      startNode({ enabled: true, paramMapping: { title: "body.title" } }),
      {
        body: { title: null },
        headers: {},
      },
    );
    expect(nulled.errors.map((error) => error.code)).toEqual(["E_PARAM_MISSING"]);

    const objectValue = resolveWebhookParams(
      startNode({ enabled: true, paramMapping: { title: "body.issue" } }),
      {
        body: { issue: { title: "nested" } },
        headers: {},
      },
    );
    expect(objectValue.errors.map((error) => error.code)).toEqual(["E_PARAM_TYPE"]);
  });

  it("rejects a non-numeric string for a number parameter", () => {
    const result = resolveWebhookParams(
      startNode({ enabled: true, paramMapping: { title: "body.title", count: "body.n" } }),
      {
        body: { title: "x", n: "3" },
        headers: {},
      },
    );
    expect(result.errors.map((error) => error.code)).toEqual(["E_PARAM_TYPE"]);
  });
});

describe("start node webhook block in workflow files", () => {
  it("parses, validates, and normalizes the webhook block", () => {
    const raw = workflow(startNode({ enabled: true, paramMapping: { title: "body.issue.title" } }));
    const parsed = parseWorkflow(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateWorkflow(parsed.value).ok).toBe(true);
    const normalized = normalizeWorkflow(parsed.value);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const start = normalized.value.graph.nodes.find((node) => node.type === "start");
    expect(start).toMatchObject({
      webhook: { enabled: true, paramMapping: { title: "body.issue.title" } },
    });
  });

  it("rejects unknown keys in the webhook block", () => {
    const parsed = parseWorkflow(workflow(startNode({ enabled: true, secret: "nope" })));
    expect(parsed.ok).toBe(false);
  });

  it("reports mapping errors against the saved file", () => {
    const parsed = parseWorkflow(
      workflow(startNode({ enabled: true, paramMapping: { nope: "body.title" } })),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const report = validateWorkflow(parsed.value);
    expect(report.ok).toBe(false);
    expect(report.errors.map((issue) => issue.code)).toContain("E_WEBHOOK_MAPPING");
  });

  it("keeps workflows without a webhook block unchanged", () => {
    const parsed = parseWorkflow(workflow(startNode()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const normalized = normalizeWorkflow(parsed.value);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const start = normalized.value.graph.nodes.find((node) => node.type === "start");
    expect(start && "webhook" in start).toBe(false);
  });
});

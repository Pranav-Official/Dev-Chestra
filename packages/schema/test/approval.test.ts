import { describe, expect, it } from "vitest";
import { analyzeGraph } from "../src/graph.js";
import { normalizeWorkflow, parseWorkflow, validateWorkflow } from "../src/index.js";
import { clone, edges, nodes, parseOk } from "./helpers.js";

function chainWithApproval(
  overrides?: (raw: Record<string, unknown>) => void,
): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    schemaVersion: 1,
    id: "approval-test",
    name: "Approval Test",
    graph: {
      nodes: [
        {
          id: "start",
          type: "start",
          name: "Start",
          params: [{ name: "topic", type: "string", required: true }],
        },
        {
          id: "a1",
          type: "approval",
          name: "Approve",
          message: "Please approve {{ start.topic }}",
          irreversible: false,
        },
        { id: "end", type: "end", name: "End", status: "success", result: "start.topic" },
      ],
      edges: [
        { id: "e1", from: "start", to: "a1" },
        { id: "e2", from: "a1", to: "end" },
      ],
    },
  };
  if (overrides) overrides(raw);
  return raw;
}

describe("approval schema", () => {
  it("validates and normalizes a minimal approval", () => {
    const raw = chainWithApproval();
    const file = parseOk(raw);
    const report = validateWorkflow(file);
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    const norm = normalizeWorkflow(file);
    expect(norm.ok).toBe(true);
    if (!norm.ok) return;
    const a1 = norm.value.graph.nodes.find((n) => n.id === "a1");
    expect(a1).toMatchObject({
      type: "approval",
      message: "Please approve {{ start.topic }}",
      irreversible: false,
    });
  });

  it("message 4096 passes, 4097 fails", () => {
    const ok = chainWithApproval((raw) => {
      (nodes(raw)[1] as Record<string, unknown>).message = "a".repeat(4096);
    });
    expect(validateWorkflow(parseOk(ok)).ok).toBe(true);
    const bad = chainWithApproval((raw) => {
      (nodes(raw)[1] as Record<string, unknown>).message = "a".repeat(4097);
    });
    const report = validateWorkflow(parseOk(bad));
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.code === "E_APPROVAL_MESSAGE")).toBe(true);
  });

  it("criteria 32 and 256 passes, 33 and 257 fails", () => {
    const ok = chainWithApproval((raw) => {
      (nodes(raw)[1] as Record<string, unknown>).criteria = Array.from({ length: 32 }, () =>
        "c".repeat(256),
      );
    });
    expect(validateWorkflow(parseOk(ok)).ok).toBe(true);
    const tooMany = chainWithApproval((raw) => {
      (nodes(raw)[1] as Record<string, unknown>).criteria = Array.from({ length: 33 }, () => "ok");
    });
    expect(
      validateWorkflow(parseOk(tooMany)).errors.some((e) => e.code === "E_APPROVAL_CRITERIA"),
    ).toBe(true);
    const tooLong = chainWithApproval((raw) => {
      (nodes(raw)[1] as Record<string, unknown>).criteria = ["a".repeat(257)];
    });
    expect(
      validateWorkflow(parseOk(tooLong)).errors.some((e) => e.code === "E_APPROVAL_CRITERIA"),
    ).toBe(true);
  });

  it("invalid template and non-ancestor roots fail", () => {
    const badTemplate = chainWithApproval((raw) => {
      (nodes(raw)[1] as Record<string, unknown>).message = "hi {{ start.topic }";
    });
    expect(validateWorkflow(parseOk(badTemplate)).errors.length).toBeGreaterThan(0);
    const badRoot = chainWithApproval((raw) => {
      (nodes(raw)[1] as Record<string, unknown>).message = "hi {{ ghost.value }}";
    });
    const report = validateWorkflow(parseOk(badRoot));
    expect(report.errors.some((e) => e.code === "E_EXPR_SCOPE")).toBe(true);
  });

  it("rejects unsupported autoApprove field", () => {
    const raw = chainWithApproval((raw2) => {
      (nodes(raw2)[1] as Record<string, unknown>).autoApprove = true;
    });
    const parsed = parseWorkflow(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain("Unrecognized");
  });

  it("rejected handle grammar: only a1.rejected allowed", () => {
    const ok = chainWithApproval((raw) => {
      nodes(raw).push({
        id: "on_reject",
        type: "shell",
        name: "OnReject",
        command: "echo no",
        timeoutMin: 5,
      });
      nodes(raw).push({
        id: "end2",
        type: "end",
        name: "End2",
        status: "success",
        result: "start.topic",
      });
      edges(raw).push({ id: "e3", from: "a1.rejected", to: "on_reject" });
      edges(raw).push({ id: "e4", from: "on_reject", to: "end2" });
      // keep original a1->end as approved path
    });
    expect(validateWorkflow(parseOk(ok)).ok).toBe(true);
    const badHandle = clone(ok);
    (edges(badHandle)[2] as Record<string, unknown>).from = "a1.approved";
    const report = validateWorkflow(parseOk(badHandle));
    expect(report.errors.some((e) => e.code === "E_EDGE_HANDLE")).toBe(true);
    const badPlain = clone(ok);
    (edges(badPlain)[2] as Record<string, unknown>).from = "a1.wrong";
    expect(validateWorkflow(parseOk(badPlain)).errors.some((e) => e.code === "E_EDGE_HANDLE")).toBe(
      true,
    );
  });

  it("unreachable graph due to missing edge is caught", () => {
    const raw = chainWithApproval((r) => {
      // remove edge to end, making end unreachable
      (r.graph as { edges: unknown[] }).edges = [{ id: "e1", from: "start", to: "a1" }];
    });
    const report = validateWorkflow(parseOk(raw));
    expect(report.errors.some((e) => e.code === "E_UNREACHABLE" || e.code === "E_NO_END")).toBe(
      true,
    );
    const { issues } = analyzeGraph(parseOk(raw).graph);
    expect(issues.some((e) => e.code === "E_UNREACHABLE")).toBe(true);
  });
});

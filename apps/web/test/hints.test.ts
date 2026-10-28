import type { GlobalStreamMessage } from "@devchestra/api";
import type { RunId } from "@devchestra/core";
import { describe, expect, it } from "vitest";
import { hintInvalidations, RECONNECT_INVALIDATIONS } from "../src/api/hints.js";

const runId = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId;

describe("global hint invalidations", () => {
  it("refreshes run lists, the run detail and bootstrap counts on run.status", () => {
    const message: GlobalStreamMessage = {
      event: "run.status",
      data: {
        runId,
        projectId: "p",
        workflowId: "w",
        status: "succeeded",
        runNumber: 1,
      },
    };
    expect(hintInvalidations(message)).toEqual([
      ["runs"],
      ["execution", runId],
      ["bootstrap"],
      ["approvals"],
    ]);
  });

  it("refreshes bootstrap on inbox, provider and config changes", () => {
    expect(hintInvalidations({ event: "inbox", data: { changed: true } })).toEqual([
      ["bootstrap"],
      ["approvals"],
    ]);
    expect(
      hintInvalidations({ event: "provider", data: { name: "codex", status: "ready" } }),
    ).toEqual([["bootstrap"]]);
    expect(hintInvalidations({ event: "config", data: { changed: true } })).toEqual([
      ["bootstrap"],
    ]);
  });

  it("refreshes non-durable derived state after a hint-stream reconnect", () => {
    expect(RECONNECT_INVALIDATIONS).toEqual([["bootstrap"], ["runs"], ["approvals"]]);
  });
});

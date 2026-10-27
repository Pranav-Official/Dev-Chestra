import { describe, expect, it } from "vitest";
import type { ChainStepState } from "../src/chain-step.js";
import { nextChainStep } from "../src/chain-step.js";
import { analyzeLinearWorkflow } from "../src/sequence.js";

const workflow = {
  graph: {
    nodes: [
      { id: "start", type: "start", params: [] },
      {
        id: "agent",
        type: "agent",
        cli: "fake",
        prompt: "go",
        output: { type: "object", properties: {} },
        permissions: { network: false, write: [] },
        workspace: { mode: "scratch" },
      },
      {
        id: "shell",
        type: "shell",
        command: "true",
        workspace: { mode: "scratch" },
        timeoutMin: 1,
      },
      { id: "end", type: "end", status: "success", result: "{}" },
    ],
    edges: [
      { from: "start", to: "agent" },
      { from: "agent", to: "shell" },
      { from: "shell", to: "end" },
    ],
  },
};

const chain = (() => {
  const result = analyzeLinearWorkflow(workflow);
  if (!result.ok) throw result.error;
  return result.value;
})();

const state = (
  status: ChainStepState["status"],
  hasOutput = status === "succeeded",
): ChainStepState => ({
  status,
  hasOutput,
});

describe("nextChainStep", () => {
  it("dispatches the first node and then each node after prior success", () => {
    const first = nextChainStep(chain, {});
    expect(first.kind).toBe("dispatch");
    if (first.kind === "dispatch") expect(first.node.id).toBe("start");

    const second = nextChainStep(chain, { start: state("succeeded"), agent: state("ready") });
    expect(second.kind).toBe("dispatch");
    if (second.kind === "dispatch") {
      expect(second.node.id).toBe("agent");
      expect(second.resume).toBe(false);
    }

    const third = nextChainStep(chain, {
      start: state("succeeded"),
      agent: state("succeeded"),
      shell: state("interrupted"),
    });
    expect(third.kind).toBe("dispatch");
    if (third.kind === "dispatch") {
      expect(third.node.id).toBe("shell");
      expect(third.resume).toBe(true);
    }
  });

  it("waits for running nodes and stops on failed nodes", () => {
    expect(nextChainStep(chain, { start: state("succeeded"), agent: state("running") }).kind).toBe(
      "wait",
    );
    const failed = nextChainStep(chain, { start: state("succeeded"), agent: state("failed") });
    expect(failed.kind).toBe("failed");
    if (failed.kind === "failed") expect(failed.status).toBe("failed");
  });

  it("completes only when every node succeeded with an output", () => {
    expect(
      nextChainStep(chain, {
        start: state("succeeded"),
        agent: state("succeeded"),
        shell: state("succeeded"),
        end: state("succeeded"),
      }),
    ).toEqual({ kind: "complete" });

    const missing = nextChainStep(chain, {
      start: state("succeeded"),
      agent: state("succeeded", false),
    });
    expect(missing.kind).toBe("failed");
  });
});

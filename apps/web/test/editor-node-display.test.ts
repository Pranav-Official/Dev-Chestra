import type {
  AgentNode,
  ApprovalNode,
  DecisionNode,
  EndNode,
  GateNode,
  JoinNode,
  ShellNode,
  StartNode,
} from "@devchestra/schema";
import { describe, expect, it } from "vitest";
import { handleSignature, subtitle } from "../src/editor/canvas/nodes.js";
import { createDefaultNode } from "../src/editor/model/index.js";

function start(params: StartNode["params"]): StartNode {
  return { id: "start", type: "start", name: "Start", params };
}

function agent(cli: AgentNode["cli"] = "codex", model?: string): AgentNode {
  return {
    id: "agent",
    type: "agent",
    name: "Agent",
    cli,
    ...(model === undefined ? {} : { model }),
    output: { type: "object" },
    permissions: { network: false, write: [] },
  };
}

function shell(command = "npm test"): ShellNode {
  return { id: "shell", type: "shell", name: "Shell", command };
}

function gate(ids: string[] = ["a", "b"]): GateNode {
  return {
    id: "gate",
    type: "gate",
    name: "Gate",
    branches: ids.map((id) => ({ id })),
  };
}

function join(mode: JoinNode["mode"] = "all", inputs: string[] = ["x", "y"]): JoinNode {
  return { id: "join", type: "join", name: "Join", mode, inputs };
}

function approval(message = "Deploy to prod", irreversible = false): ApprovalNode {
  return { id: "approval", type: "approval", name: "Approval", message, irreversible };
}

function end(status: EndNode["status"] = "success"): EndNode {
  return { id: "end", type: "end", name: "End", status, result: "done" };
}

function decision(
  mode: DecisionNode["mode"],
  provider: DecisionNode["provider"] = "typesafe-jev",
): DecisionNode {
  return {
    id: "decision",
    type: "decision",
    name: "Decision",
    provider,
    state: "{}",
    instructions: "Decide yes or no from the state.",
    mode,
    onError: "fail",
  };
}

describe("subtitle pins current output per node type", () => {
  it("start counts parameters", () => {
    expect(subtitle(start([]))).toBe("0 parameters");
    expect(subtitle(start([{ name: "p", type: "string", required: true }]))).toBe("1 parameter");
    expect(
      subtitle(
        start([
          { name: "a", type: "string", required: true },
          { name: "b", type: "number", required: false },
        ]),
      ),
    ).toBe("2 parameters");
  });

  it("agent shows cli, plus model when set", () => {
    expect(subtitle(agent("codex"))).toBe("codex");
    expect(subtitle(agent("codex", "gpt-5"))).toBe("codex · gpt-5");
  });

  it("shell shows the command verbatim", () => {
    expect(subtitle(shell("npm test"))).toBe("npm test");
  });

  it("gate counts branches with branch/branches plural", () => {
    expect(subtitle(gate(["only"]))).toBe("1 branch");
    expect(subtitle(gate(["a", "b"]))).toBe("2 branches");
    expect(subtitle(gate([]))).toBe("0 branches");
  });

  it("join shows mode and input count", () => {
    expect(subtitle(join("all", ["x", "y"]))).toBe("all · 2 inputs");
    expect(subtitle(join("first", ["x"]))).toBe("first · 1 input");
    expect(subtitle(join("all", []))).toBe("all · 0 inputs");
  });

  it("approval shows message, irreversible prefix, or fallback", () => {
    expect(subtitle(approval("Deploy to prod", false))).toBe("Deploy to prod");
    expect(subtitle(approval("Deploy to prod", true))).toBe("Irreversible · Deploy to prod");
    expect(subtitle(approval("", false))).toBe("Waits for a person");
    expect(subtitle(approval("   ", false))).toBe("Waits for a person");
  });

  it("approval trims a long message to 32 chars", () => {
    const long = "abcdefghijklmnopqrstuvwxyz0123456789EXTRA";
    expect(subtitle(approval(long, false))).toBe(long.slice(0, 32));
    expect(subtitle(approval(long, true))).toBe(`Irreversible · ${long.slice(0, 32)}`);
  });

  it("end shows the status", () => {
    expect(subtitle(end("success"))).toBe("Ends as success");
    expect(subtitle(end("failed"))).toBe("Ends as failed");
    expect(subtitle(end("rejected"))).toBe("Ends as rejected");
  });

  it("decision shows the provider and instruction prefix", () => {
    expect(subtitle(decision({ kind: "boolean" }))).toBe(
      "typesafe-jev · Decide yes or no from the state.",
    );
    expect(
      subtitle(decision({ kind: "boolean" }, "cloudflare-clef")).startsWith("cloudflare-clef · "),
    ).toBe(true);
  });
});

describe("handleSignature pins current output per node type", () => {
  it("gate joins branch ids", () => {
    expect(handleSignature(gate(["a", "b"]))).toBe("gate:a|b");
    expect(handleSignature(gate(["only"]))).toBe("gate:only");
  });

  it("join joins inputs", () => {
    expect(handleSignature(join("all", ["x", "y"]))).toBe("join:x|y");
  });

  it("approval returns the node id", () => {
    expect(handleSignature(approval())).toBe("approval:approval");
  });

  it("decision joins branch/band handles plus uncertain", () => {
    expect(handleSignature(decision({ kind: "boolean" }))).toBe("decision:true|false|uncertain");
    expect(
      handleSignature(
        decision({
          kind: "choice",
          options: [{ value: "a" }, { value: "b" }],
          branches: [
            { id: "a", values: ["a"] },
            { id: "b", values: ["b"] },
          ],
        }),
      ),
    ).toBe("decision:a|b|uncertain");
    expect(
      handleSignature(
        decision({
          kind: "score",
          levels: [{ label: "low" }, { label: "high" }],
          bands: [
            { id: "high", atLeast: 1 },
            { id: "low", atLeast: null },
          ],
        }),
      ),
    ).toBe("decision:high|low|uncertain");
  });

  it("start/agent/shell/end return null", () => {
    expect(handleSignature(start([]))).toBeNull();
    expect(handleSignature(agent())).toBeNull();
    expect(handleSignature(shell())).toBeNull();
    expect(handleSignature(end())).toBeNull();
  });

  it("loop pins its success/exhausted output handles", () => {
    const loop = createDefaultNode("loop", []);
    expect(handleSignature(loop)).toBe(`loop:${loop.id}`);
  });
});

describe("tiered agent node display", () => {
  const tiered: AgentNode = {
    id: "agent",
    type: "agent",
    name: "Agent",
    tier: "high",
    output: { type: "object" },
    permissions: { network: false, write: [] },
  };

  it("names the tier instead of a provider and model", () => {
    expect(subtitle(tiered)).toBe("High tier");
    expect(subtitle({ ...tiered, tier: "low" })).toBe("Low tier");
  });

  it("does not print 'undefined' for a node with neither provider nor tier", () => {
    const { tier: _tier, ...bare } = tiered;
    expect(subtitle(bare)).toBe("No provider");
  });
});

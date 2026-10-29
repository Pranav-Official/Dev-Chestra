import type { DecisionTestResult } from "@devchestra/api";
import {
  DECISION_PROVIDER_LABELS,
  type DecisionNode,
  type Issue,
  type WorkflowNode,
} from "@devchestra/schema";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { DecisionTester } from "../src/editor/inspector/DecisionTester.js";
import { Inspector } from "../src/editor/inspector/Inspector.js";

function decisionNode(overrides: Partial<DecisionNode> = {}): DecisionNode {
  return {
    id: "decision",
    type: "decision",
    name: "Decision",
    provider: "typesafe-jev",
    state: "{}",
    instructions: "Decide yes or no from the state.",
    mode: { kind: "boolean" },
    onError: "fail",
    ...overrides,
  };
}

function Harness({ initial, issues = [] }: { initial: WorkflowNode; issues?: Issue[] }) {
  const [node, setNode] = useState<WorkflowNode | null>(initial);
  return (
    <div>
      <Inspector
        node={node}
        issues={issues}
        projectId="project-1"
        edges={[]}
        onPatch={(nodeId, patch) => {
          void nodeId;
          setNode((previous) =>
            previous === null ? previous : ({ ...previous, ...patch } as WorkflowNode),
          );
        }}
        onRoutingChange={(nodeId, patch) => {
          void nodeId;
          setNode((previous) =>
            previous === null ? previous : ({ ...previous, ...patch } as WorkflowNode),
          );
        }}
      />
      <pre data-testid="node-log">{JSON.stringify(node)}</pre>
    </div>
  );
}

function currentNode(): DecisionNode {
  return JSON.parse(screen.getByTestId("node-log").textContent ?? "{}") as DecisionNode;
}

function readyProviders() {
  return [
    {
      id: "typesafe-jev",
      label: DECISION_PROVIDER_LABELS["typesafe-jev"],
      ready: true,
      missing: [],
    },
    {
      id: "cloudflare-clef",
      label: DECISION_PROVIDER_LABELS["cloudflare-clef"],
      ready: false,
      missing: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AUTH_TOKEN"],
    },
    {
      id: "cloudflare-clef-flash",
      label: DECISION_PROVIDER_LABELS["cloudflare-clef-flash"],
      ready: false,
      missing: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AUTH_TOKEN"],
    },
  ] as Awaited<ReturnType<typeof api.listDecisionProviders>>;
}

describe("DecisionForm provider", () => {
  it("lists provider labels and reports readiness with missing names only", async () => {
    vi.spyOn(api, "listDecisionProviders").mockResolvedValue(readyProviders());
    try {
      render(<Harness initial={decisionNode()} />);
      const select = await screen.findByTestId("decision-provider");
      expect(select).toHaveTextContent(DECISION_PROVIDER_LABELS["typesafe-jev"]);
      expect(select).toHaveTextContent(DECISION_PROVIDER_LABELS["cloudflare-clef"]);
      expect(await screen.findByTestId("decision-provider-ready")).toHaveTextContent("is ready");

      fireEvent.change(screen.getByTestId("decision-provider"), {
        target: { value: "cloudflare-clef" },
      });
      const missing = await screen.findByTestId("decision-provider-missing");
      expect(missing).toHaveTextContent("CLOUDFLARE_ACCOUNT_ID");
      expect(missing).toHaveTextContent("CLOUDFLARE_AUTH_TOKEN");
      expect(missing).toHaveTextContent("devchestra/.env");
      expect(missing.textContent ?? "").not.toMatch(/sk-|token-[A-Za-z0-9]/);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("rejects a model override that breaks the pattern", async () => {
    vi.spyOn(api, "listDecisionProviders").mockResolvedValue(readyProviders());
    try {
      const user = userEvent.setup();
      render(<Harness initial={decisionNode()} />);
      await screen.findByTestId("decision-provider-ready");
      await user.type(screen.getByTestId("decision-model"), "!!bad model!!");
      expect(await screen.findByText(/must match/)).toBeInTheDocument();
      expect(currentNode().model).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("surfaces schema validation messages inline", () => {
    const issues: Issue[] = [
      {
        severity: "error",
        code: "E_DECISION_THRESHOLD",
        message: "Decision boolean falseAt must be <= trueAt.",
        pointer: "/graph/nodes/0/mode/falseAt",
        nodeId: "decision",
      },
    ];
    render(<Harness initial={decisionNode()} issues={issues} />);
    expect(screen.getByText("Decision boolean falseAt must be <= trueAt.")).toBeInTheDocument();
  });
});

describe("DecisionForm mode switching", () => {
  it("replaces the mode config in one patch and keeps option<->branch consistent", async () => {
    vi.spyOn(api, "listDecisionProviders").mockResolvedValue(readyProviders());
    try {
      const user = userEvent.setup();
      render(<Harness initial={decisionNode()} />);
      await screen.findByTestId("decision-provider-ready");
      await user.click(screen.getByTestId("decision-mode-choice"));
      const after = currentNode();
      expect(after.mode.kind).toBe("choice");
      if (after.mode.kind !== "choice") return;
      const covered = new Map<string, string>();
      for (const branch of after.mode.branches)
        for (const value of branch.values) covered.set(value, branch.id);
      for (const option of after.mode.options) expect(covered.get(option.value)).toBeDefined();

      await user.click(screen.getByTestId("decision-mode-score"));
      const scored = currentNode();
      expect(scored.mode.kind).toBe("score");
      if (scored.mode.kind !== "score") return;
      expect(scored.mode.levels.length).toBeGreaterThanOrEqual(2);
      expect(scored.mode.bands.at(-1)?.atLeast).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("adds an option into the first branch and edits branch membership", async () => {
    vi.spyOn(api, "listDecisionProviders").mockResolvedValue(readyProviders());
    try {
      const user = userEvent.setup();
      render(
        <Harness
          initial={decisionNode({
            mode: {
              kind: "choice",
              options: [{ value: "yes" }, { value: "no" }],
              branches: [
                { id: "yes", values: ["yes"] },
                { id: "no", values: ["no"] },
              ],
            },
          })}
        />,
      );
      await screen.findByTestId("decision-provider-ready");
      await user.click(screen.getByTestId("decision-option-add"));
      const after = currentNode();
      if (after.mode.kind !== "choice") throw new Error("expected choice");
      const added = after.mode.options.at(-1)?.value ?? "";
      expect(after.mode.branches[0]?.values).toContain(added);

      await user.selectOptions(screen.getByTestId("decision-option-0-branch"), "no");
      const moved = currentNode();
      if (moved.mode.kind !== "choice") throw new Error("expected choice");
      expect(moved.mode.branches.find((branch) => branch.id === "no")?.values).toContain("yes");
      expect(moved.mode.branches.find((branch) => branch.id === "yes")?.values).not.toContain(
        "yes",
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("blocks branch renames while connected", async () => {
    vi.spyOn(api, "listDecisionProviders").mockResolvedValue(readyProviders());
    try {
      const user = userEvent.setup();
      const edges = [{ id: "e1", from: "decision.yes", to: "end" }];
      const { rerender } = render(
        <Inspector
          node={decisionNode({
            mode: {
              kind: "choice",
              options: [{ value: "yes" }],
              branches: [{ id: "yes", values: ["yes"] }],
            },
          })}
          issues={[]}
          projectId="project-1"
          edges={edges}
          onPatch={() => undefined}
          onRoutingChange={() => undefined}
        />,
      );
      void rerender;
      await screen.findByTestId("decision-provider-ready");
      const input = screen.getByTestId("decision-branch-0-id") as HTMLInputElement;
      await user.clear(input);
      await user.type(input, "maybe");
      fireEvent.blur(input);
      expect(await screen.findByText(/Disconnect its edge before renaming/)).toBeInTheDocument();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("resets bands to defaults when levels change", async () => {
    vi.spyOn(api, "listDecisionProviders").mockResolvedValue(readyProviders());
    try {
      const user = userEvent.setup();
      render(
        <Harness
          initial={decisionNode({
            mode: {
              kind: "score",
              levels: [{ label: "low" }, { label: "high" }],
              bands: [
                { id: "high", atLeast: 1 },
                { id: "low", atLeast: null },
              ],
            },
          })}
        />,
      );
      await screen.findByTestId("decision-provider-ready");
      await user.click(screen.getByTestId("decision-level-add"));
      const after = currentNode();
      if (after.mode.kind !== "score") throw new Error("expected score");
      expect(after.mode.levels).toHaveLength(3);
      expect(after.mode.bands.at(-1)?.atLeast).toBeNull();
      const numbers = after.mode.bands.map((band) => band.atLeast);
      for (let i = 1; i < numbers.length - 1; i += 1)
        expect(numbers[i] as number).toBeLessThan(numbers[i - 1] as number);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

function booleanResult(): DecisionTestResult {
  return {
    output: {
      kind: "boolean",
      value: true,
      probability: 0.82,
      confidence: 0.82,
      confidenceSource: "derived",
      model: "jev-latest",
    },
    routing: { branch: "true", reason: "matched" },
    latencyMs: 321,
    usage: { inputTokens: 120, outputTokens: 8 },
  };
}

describe("DecisionTester", () => {
  function testerHarness(
    node: DecisionNode,
    runTest?: (n: DecisionNode, s: string) => Promise<DecisionTestResult>,
    ready = true,
  ) {
    return (
      <DecisionTester
        node={node}
        projectId="project-1"
        readiness={{ ready, missing: ready ? [] : ["TYPESAFE_API_KEY"], unknown: false }}
        runTest={runTest}
      />
    );
  }

  it("warns that the test calls the real provider and may cost tokens", () => {
    render(testerHarness(decisionNode(), async () => booleanResult()));
    expect(screen.getByTestId("decision-tester-run")).toBeInTheDocument();
    expect(screen.getAllByText(/may cost tokens/).length).toBeGreaterThan(0);
  });

  it("disables the run when the provider is not ready", () => {
    render(testerHarness(decisionNode(), async () => booleanResult(), false));
    const run = screen.getByTestId("decision-tester-run") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.title).toMatch(/not ready/);
  });

  it("disables the run when the node is invalid", () => {
    render(testerHarness(decisionNode({ instructions: "" }), async () => booleanResult()));
    const run = screen.getByTestId("decision-tester-run") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.title).toMatch(/Instructions/);
  });

  it("shows the normalized boolean output with branch and reason", async () => {
    const user = userEvent.setup();
    const runTest = vi.fn(async () => booleanResult());
    render(testerHarness(decisionNode(), runTest));
    await user.click(screen.getByTestId("decision-tester-run"));
    expect(await screen.findByTestId("decision-tester-result")).toBeInTheDocument();
    expect(screen.getByTestId("decision-tester-value")).toHaveTextContent("Yes");
    expect(screen.getByTestId("decision-tester-route")).toHaveTextContent("true");
    expect(screen.getByTestId("decision-tester-route")).toHaveTextContent("matched");
    expect(screen.getByTestId("decision-tester-confidence")).toHaveTextContent("derived");
    expect(screen.getByTestId("decision-tester-model")).toHaveTextContent("jev-latest");
    expect(screen.getByTestId("decision-tester-latency")).toHaveTextContent("321");
    expect(screen.getByTestId("decision-tester-usage")).toHaveTextContent("120");
    expect(runTest).toHaveBeenCalledTimes(1);
  });

  it("shows choice probabilities and the score level for other modes", async () => {
    const user = userEvent.setup();
    const choice: DecisionNode = decisionNode({
      mode: {
        kind: "choice",
        options: [{ value: "a" }, { value: "b" }],
        branches: [
          { id: "a", values: ["a"] },
          { id: "b", values: ["b"] },
        ],
      },
    });
    const runTest = vi.fn(
      async (): Promise<DecisionTestResult> => ({
        output: {
          kind: "choice",
          value: "b",
          probabilities: { a: 0.3, b: 0.7 },
          confidence: 0.7,
          confidenceSource: "provider",
          model: "clef",
        },
        routing: { branch: "b", reason: "matched" },
        latencyMs: 100,
      }),
    );
    const { unmount } = render(testerHarness(choice, runTest));
    await user.click(screen.getByTestId("decision-tester-run"));
    expect(await screen.findByTestId("decision-tester-prob-b")).toHaveTextContent("70.0%");
    expect(screen.getByTestId("decision-tester-value")).toHaveTextContent("b");
    unmount();

    const score: DecisionNode = decisionNode({
      mode: {
        kind: "score",
        levels: [{ label: "low" }, { label: "high" }],
        bands: [
          { id: "high", atLeast: 1 },
          { id: "low", atLeast: null },
        ],
      },
    });
    const runScore = vi.fn(
      async (): Promise<DecisionTestResult> => ({
        output: {
          kind: "score",
          value: "high",
          score: 1.2,
          probabilities: { low: 0.2, high: 0.8 },
          confidence: 0.8,
          confidenceSource: "derived",
          model: "jev-latest",
        },
        routing: { branch: "high", reason: "matched" },
        latencyMs: 90,
      }),
    );
    render(testerHarness(score, runScore));
    await user.click(screen.getByTestId("decision-tester-run"));
    expect(await screen.findByTestId("decision-tester-value")).toHaveTextContent("high");
    expect(screen.getByTestId("decision-tester-value")).toHaveTextContent("1.2");
  });

  it("shows redacted errors only", async () => {
    const user = userEvent.setup();
    const runTest = vi.fn(async () => {
      throw new Error("E_PROVIDER: provider refused the request");
    });
    render(testerHarness(decisionNode(), runTest));
    await user.click(screen.getByTestId("decision-tester-run"));
    expect(await screen.findByTestId("decision-tester-error")).toHaveTextContent(
      "E_PROVIDER: provider refused the request",
    );
  });

  it("shows a busy state while the test is in flight", async () => {
    const user = userEvent.setup();
    let resolve!: (value: DecisionTestResult) => void;
    const runTest = vi.fn(
      () =>
        new Promise<DecisionTestResult>((done) => {
          resolve = done;
        }),
    );
    render(testerHarness(decisionNode(), runTest));
    await user.click(screen.getByTestId("decision-tester-run"));
    expect(await screen.findByText("Asking…")).toBeInTheDocument();
    resolve(booleanResult());
    expect(await screen.findByTestId("decision-tester-result")).toBeInTheDocument();
  });
});

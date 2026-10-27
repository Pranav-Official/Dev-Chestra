import type { AgentNode, Issue, JsonSchemaObject, StartNode, WorkflowNode } from "@relay/schema";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Inspector } from "../src/editor/inspector/Inspector.js";
import type { BufferValidity } from "../src/editor/inspector/types.js";

interface PatchEntry {
  nodeId: string;
  patch: Partial<WorkflowNode>;
}

function Harness({
  initial,
  alternate,
  issues = [],
}: {
  initial: WorkflowNode;
  alternate?: WorkflowNode;
  issues?: Issue[];
}) {
  const [node, setNode] = useState<WorkflowNode | null>(initial);
  const [patches, setPatches] = useState<PatchEntry[]>([]);
  const [validity, setValidity] = useState<BufferValidity[]>([]);

  return (
    <div>
      <Inspector
        node={node}
        issues={issues}
        onPatch={(nodeId, patch) => {
          setPatches((previous) => [...previous, { nodeId, patch }]);
          setNode((previous) =>
            previous === null ? previous : ({ ...previous, ...patch } as WorkflowNode),
          );
        }}
        onBufferValidityChange={(state) => setValidity((previous) => [...previous, state])}
      />
      <button type="button" data-testid="switch-node" onClick={() => setNode(alternate ?? null)}>
        Switch
      </button>
      <pre data-testid="patch-log">{JSON.stringify(patches)}</pre>
      <pre data-testid="validity-log">{JSON.stringify(validity)}</pre>
    </div>
  );
}

function patches(): PatchEntry[] {
  return JSON.parse(screen.getByTestId("patch-log").textContent ?? "[]") as PatchEntry[];
}

function lastOutput(): JsonSchemaObject {
  const patch = patches().at(-1)?.patch as { output?: JsonSchemaObject } | undefined;
  if (patch?.output === undefined) throw new Error("No output patch yet");
  return patch.output;
}

function validity(): BufferValidity[] {
  return JSON.parse(screen.getByTestId("validity-log").textContent ?? "[]") as BufferValidity[];
}

async function expectInvalid(): Promise<void> {
  await waitFor(() => expect(validity().at(-1)?.valid).toBe(false));
}

async function expectValid(): Promise<void> {
  await waitFor(() => expect(validity().at(-1)?.valid).toBe(true));
}

function agentWith(output: JsonSchemaObject): AgentNode {
  return {
    id: "node-agent",
    type: "agent",
    name: "Research",
    cli: "fake",
    prompt: "Find facts.",
    output,
    permissions: { network: false, write: ["workspace"] },
    workspace: { mode: "scratch" },
  };
}

const emptyAgent = agentWith({ type: "object", properties: {}, additionalProperties: false });
const rawAgent = agentWith({ type: "object", additionalProperties: true });

const start: StartNode = {
  id: "node-start",
  type: "start",
  name: "Start",
  params: [],
};

const complex: JsonSchemaObject = {
  type: "object",
  title: "Result",
  description: "Root description",
  $defs: { Tag: { type: "string" } },
  properties: {
    summary: { type: "string", description: "Short", minLength: 1 },
    points: { type: "array", items: { type: "string" }, maxItems: 20, minItems: 0 },
    meta: {
      type: "object",
      description: "Nested metadata",
      properties: { score: { type: "number" } },
      required: ["score"],
      additionalProperties: false,
    },
  },
  required: ["summary", "points"],
  additionalProperties: false,
};

describe("Output schema basic row editor", () => {
  it("configures a default summary string and points array without editing workflow JSON", async () => {
    render(<Harness initial={emptyAgent} />);
    expect(screen.getByText(/No output properties yet/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("inspector-output-add-property"));
    await screen.findByTestId("inspector-output-row-0");
    fireEvent.change(screen.getByTestId("inspector-output-row-0-name"), {
      target: { value: "summary" },
    });
    await waitFor(() => {
      expect(lastOutput().properties).toEqual({ summary: { type: "string" } });
    });

    fireEvent.click(screen.getByTestId("inspector-output-add-property"));
    await screen.findByTestId("inspector-output-row-1");
    fireEvent.change(screen.getByTestId("inspector-output-row-1-name"), {
      target: { value: "points" },
    });
    fireEvent.change(screen.getByTestId("inspector-output-row-1-type"), {
      target: { value: "arrayStrings" },
    });
    await waitFor(() => {
      expect(lastOutput().properties).toEqual({
        summary: { type: "string" },
        points: { type: "array", items: { type: "string" }, maxItems: 20 },
      });
    });

    fireEvent.click(screen.getByTestId("inspector-output-row-1-required"));
    await waitFor(() => expect(lastOutput().required).toEqual(["points"]));
    expect(lastOutput().type).toBe("object");
    expect(lastOutput().additionalProperties).toBe(false);
  });

  it("preserves constraints, nested schemas, $defs and top-level annotations", async () => {
    render(<Harness initial={agentWith(complex)} />);

    const metaType = screen.getByTestId("inspector-output-row-2-type");
    expect(metaType).toBeDisabled();
    expect(
      screen.getByText(/Advanced or nested schema keywords are preserved/),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("inspector-output-row-0-description"), {
      target: { value: "A longer summary" },
    });
    await waitFor(() => {
      const output = lastOutput();
      expect(output.title).toBe("Result");
      expect(output.description).toBe("Root description");
      expect(output.$defs).toEqual({ Tag: { type: "string" } });
      expect(output.properties).toMatchObject({
        summary: { type: "string", description: "A longer summary", minLength: 1 },
      });
    });

    fireEvent.change(screen.getByTestId("inspector-output-row-1-max-items"), {
      target: { value: "30" },
    });
    await waitFor(() => {
      expect(lastOutput().properties).toMatchObject({
        points: { type: "array", items: { type: "string" }, maxItems: 30, minItems: 0 },
      });
    });

    fireEvent.click(screen.getByTestId("inspector-output-row-2-required"));
    await waitFor(() => {
      const output = lastOutput();
      expect(output.required).toEqual(["meta", "points", "summary"]);
      expect(output.properties).toMatchObject({
        meta: {
          type: "object",
          description: "Nested metadata",
          properties: { score: { type: "number" } },
          required: ["score"],
          additionalProperties: false,
        },
      });
    });
  });

  it("applies array bounds when item schemas carry string constraints or stay complex", async () => {
    const output: JsonSchemaObject = {
      type: "object",
      properties: {
        points: {
          type: "array",
          items: { type: "string", maxLength: 500 },
          maxItems: 8,
        },
        notes: {
          type: "array",
          items: { type: "string", "x-preserved": true },
          maxItems: 4,
        },
      },
      required: ["points", "notes"],
      additionalProperties: false,
    };
    render(<Harness initial={agentWith(output)} />);

    expect(screen.getByTestId("inspector-output-row-0-type")).not.toBeDisabled();
    expect(screen.getByTestId("inspector-output-row-1-type")).toBeDisabled();

    fireEvent.change(screen.getByTestId("inspector-output-row-0-max-items"), {
      target: { value: "7" },
    });
    await waitFor(() => {
      expect(lastOutput().properties).toMatchObject({
        points: { type: "array", items: { type: "string", maxLength: 500 }, maxItems: 7 },
      });
    });

    fireEvent.change(screen.getByTestId("inspector-output-row-1-max-items"), {
      target: { value: "3" },
    });
    await waitFor(() => {
      expect(lastOutput().properties).toMatchObject({
        notes: { type: "array", items: { type: "string", "x-preserved": true }, maxItems: 3 },
      });
    });
  });

  it("blocks a partial array bound and does not write a lossy schema", async () => {
    render(<Harness initial={agentWith(complex)} />);
    const before = patches().length;
    fireEvent.change(screen.getByTestId("inspector-output-row-1-max-items"), {
      target: { value: "" },
    });
    await expectInvalid();
    expect(patches().length).toBe(before);
    expect(screen.getByTestId("inspector-output-row-1-max-items")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });
});

describe("Flexible raw and Any output modes", () => {
  it("starts raw, scaffolds strict fields only on explicit Structured, and round-trips the cache", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness initial={rawAgent} />);
    expect(screen.getByTestId("inspector-output-mode-raw")).toBeChecked();
    expect(screen.getByTestId("inspector-output-raw-note")).toHaveTextContent(
      "Any keys and JSON values are allowed, including empty objects.",
    );
    expect(screen.getByTestId("inspector-output-raw-note")).toHaveTextContent(
      "does not verify task quality",
    );
    expect(patches()).toHaveLength(0);

    await user.click(screen.getByTestId("inspector-output-mode-structured"));
    await waitFor(() => {
      expect(lastOutput()).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["summary", "points"],
      });
      expect(lastOutput().properties).toMatchObject({
        points: {
          type: "array",
          items: { type: "string", maxLength: 500 },
          minItems: 1,
          maxItems: 8,
        },
      });
    });
    expect(screen.getByTestId("inspector-output-structured-note")).toHaveTextContent(
      "No previous structured schema was cached",
    );

    fireEvent.change(screen.getByTestId("inspector-output-row-1-max-items"), {
      target: { value: "7" },
    });
    await waitFor(() => {
      expect(lastOutput().properties).toMatchObject({
        points: { items: { type: "string", maxLength: 500 }, maxItems: 7 },
      });
    });

    await user.click(screen.getByTestId("inspector-output-mode-raw"));
    await waitFor(() =>
      expect(lastOutput()).toEqual({ type: "object", additionalProperties: true }),
    );
    await user.click(screen.getByTestId("inspector-output-mode-structured"));
    await waitFor(() => {
      expect(lastOutput().properties).toMatchObject({
        points: { items: { type: "string", maxLength: 500 }, maxItems: 7 },
      });
    });
    expect(screen.getByTestId("inspector-output-structured-note")).toHaveTextContent(
      "Restored the previous structured schema",
    );

    const saved = lastOutput();
    unmount();
    render(<Harness initial={{ ...rawAgent, output: saved }} />);
    expect(screen.getByTestId("inspector-output-mode-structured")).toBeChecked();
    expect(screen.getByTestId("inspector-output-row-1-max-items")).toHaveValue("7");
    expect(patches()).toHaveLength(0);
  });

  it("does not cache one node's structured schema for a different raw node", async () => {
    const user = userEvent.setup();
    const custom = agentWith({
      type: "object",
      additionalProperties: false,
      properties: { secret: { type: "string" } },
      required: ["secret"],
    });
    const otherRaw = { ...rawAgent, id: "node-agent-b" };
    render(<Harness initial={custom} alternate={otherRaw} />);
    await user.click(screen.getByTestId("inspector-output-mode-raw"));
    await waitFor(() =>
      expect(lastOutput()).toEqual({ type: "object", additionalProperties: true }),
    );

    await user.click(screen.getByTestId("switch-node"));
    expect(screen.getByTestId("inspector-output-mode-raw")).toBeChecked();
    await user.click(screen.getByTestId("inspector-output-mode-structured"));
    await waitFor(() => {
      const output = lastOutput();
      expect(output.properties).toHaveProperty("summary");
      expect(output.properties).not.toHaveProperty("secret");
    });
  });

  it("preserves Any {} and opens newly created Object properties with AP true", async () => {
    render(
      <Harness
        initial={agentWith({
          type: "object",
          additionalProperties: false,
          properties: {
            record: {},
            list: { type: "array", items: { type: "string" }, maxItems: 2 },
          },
          required: ["record"],
        })}
      />,
    );
    expect(screen.getByTestId("inspector-output-row-0-type")).toHaveValue("any");

    fireEvent.click(screen.getByTestId("inspector-output-row-0-required"));
    await waitFor(() => {
      expect(lastOutput().properties).toMatchObject({ record: {} });
      expect(lastOutput().required).toBeUndefined();
    });

    fireEvent.change(screen.getByTestId("inspector-output-row-1-max-items"), {
      target: { value: "3" },
    });
    await waitFor(() =>
      expect(lastOutput().properties).toMatchObject({ record: {}, list: { maxItems: 3 } }),
    );

    fireEvent.click(screen.getByTestId("inspector-output-add-property"));
    await screen.findByTestId("inspector-output-row-2");
    fireEvent.change(screen.getByTestId("inspector-output-row-2-name"), {
      target: { value: "meta" },
    });
    fireEvent.change(screen.getByTestId("inspector-output-row-2-type"), {
      target: { value: "object" },
    });
    await waitFor(() => {
      expect(lastOutput().properties).toMatchObject({
        record: {},
        meta: { type: "object", additionalProperties: true },
      });
      expect(lastOutput().properties).not.toMatchObject({
        meta: { properties: {}, additionalProperties: false },
      });
    });
  });

  it("preserves own __proto__, open nested objects, bounds and $defs across a mode round trip", async () => {
    const user = userEvent.setup();
    const legacy = JSON.parse(
      '{"type":"object","additionalProperties":false,"properties":{"__proto__":{"type":"string"},"meta":{"type":"object","additionalProperties":true},"points":{"type":"array","items":{"type":"string"},"maxItems":8}},"required":["__proto__","meta","points"],"$defs":{"Tag":{"type":"string"}}}',
    ) as JsonSchemaObject;
    render(<Harness initial={agentWith(legacy)} />);
    expect(screen.getByTestId("inspector-output-mode-structured")).toBeChecked();
    expect(patches()).toHaveLength(0);

    await user.click(screen.getByTestId("inspector-output-mode-raw"));
    await waitFor(() =>
      expect(lastOutput()).toEqual({ type: "object", additionalProperties: true }),
    );
    await user.click(screen.getByTestId("inspector-output-mode-structured"));
    await waitFor(() => {
      const output = lastOutput();
      expect(output.$defs).toEqual({ Tag: { type: "string" } });
      expect(output.required).toEqual(["__proto__", "meta", "points"]);
      expect(output.properties).toMatchObject({
        meta: { type: "object", additionalProperties: true },
        points: { type: "array", items: { type: "string" }, maxItems: 8 },
      });
      expect(Object.hasOwn(output.properties ?? {}, "__proto__")).toBe(true);
    });
  });

  it("explains the required object root and the value Any field for scalar/array roots", () => {
    render(<Harness initial={agentWith({ type: "string" })} />);
    const caption = screen.getByTestId("inspector-output-root-caption");
    expect(caption).toHaveTextContent("submit_result arguments must be a JSON object");
    expect(caption).toHaveTextContent('{ "value": ... }');
  });

  it("lets an explicit Raw choice reset an active invalid advanced buffer", async () => {
    const user = userEvent.setup();
    render(<Harness initial={agentWith(complex)} />);
    await user.click(screen.getByTestId("inspector-output-advanced-toggle"));
    fireEvent.change(screen.getByTestId("inspector-output-advanced-json"), {
      target: { value: "{" },
    });
    await expectInvalid();

    await user.click(screen.getByTestId("inspector-output-mode-raw"));
    await waitFor(() =>
      expect(lastOutput()).toEqual({ type: "object", additionalProperties: true }),
    );
    await expectValid();
  });
});

describe("Output schema advanced JSON fallback", () => {
  it("applies only structurally valid JSON and blocks Save/Run for an invalid buffer", async () => {
    const user = userEvent.setup();
    render(<Harness initial={emptyAgent} alternate={start} />);

    await user.click(screen.getByTestId("inspector-output-advanced-toggle"));
    const textarea = screen.getByTestId("inspector-output-advanced-json");
    const before = patches().length;
    fireEvent.change(textarea, { target: { value: '{"type":"object",' } });
    await expectInvalid();
    expect(patches().length).toBe(before);

    fireEvent.change(textarea, {
      target: {
        value:
          '{"type":"object","properties":{"summary":{"type":"string"}},"additionalProperties":false}',
      },
    });
    await waitFor(() => {
      expect(lastOutput().properties).toEqual({ summary: { type: "string" } });
    });
    await expectValid();

    const afterValid = patches().length;
    fireEvent.change(textarea, { target: { value: "[]" } });
    await expectInvalid();
    expect(patches().length).toBe(afterValid);

    await user.click(screen.getByTestId("switch-node"));
    expect(screen.getByTestId("inspector-node-name")).toHaveValue("Start");
    await expectValid();
  });

  it("round-trips a __proto__ property name with Object.fromEntries semantics", async () => {
    render(<Harness initial={emptyAgent} />);
    fireEvent.click(screen.getByTestId("inspector-output-advanced-toggle"));
    fireEvent.change(screen.getByTestId("inspector-output-advanced-json"), {
      target: {
        value:
          '{"type":"object","properties":{"__proto__":{"type":"string"},"safe":{"type":"number"}},"additionalProperties":false}',
      },
    });
    await waitFor(() => {
      const output = lastOutput();
      expect(Object.hasOwn(output.properties ?? {}, "__proto__")).toBe(true);
      expect(Object.hasOwn(output.properties ?? {}, "safe")).toBe(true);
    });
    const logged = JSON.parse(screen.getByTestId("patch-log").textContent ?? "[]") as PatchEntry[];
    const output = logged.at(-1)?.patch as { output: JsonSchemaObject };
    expect(Object.hasOwn(output.output.properties ?? {}, "__proto__")).toBe(true);
    expect("polluted" in {}).toBe(false);
  });

  it("keeps basic rows available for a simple schema and shows a read-only JSON view", async () => {
    render(<Harness initial={agentWith(complex)} />);
    expect(screen.getByTestId("inspector-output-view-json")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-output-advanced-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-output-row-0-name")).toHaveAccessibleName("Property name");
    expect(screen.getByTestId("inspector-output-row-0-type")).toHaveAccessibleName("Type");
    expect(screen.getByTestId("inspector-output-row-0-required")).toHaveAccessibleName("Required");
  });
});

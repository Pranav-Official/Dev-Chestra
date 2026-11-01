import type { Issue, StartNode } from "@devchestra/schema";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { Inspector } from "../src/editor/inspector/Inspector.js";

const NODE_ID = "node-start";

function startNode(overrides: Partial<StartNode> = {}): StartNode {
  return {
    id: NODE_ID,
    type: "start",
    name: "Start",
    params: [
      { name: "topic", type: "string", required: true },
      { name: "count", type: "number", default: 1, required: false },
    ],
    ...overrides,
  };
}

/** Keeps every raw patch, including explicit `undefined` values that a JSON log would drop. */
let patches: Array<Partial<StartNode>> = [];

function Harness({ initial, issues = [] }: { initial: StartNode; issues?: Issue[] }) {
  const [node, setNode] = useState<StartNode>(initial);
  return (
    <Inspector
      node={node}
      issues={issues}
      onPatch={(_nodeId, patch) => {
        patches.push(patch as Partial<StartNode>);
        setNode((previous) => ({ ...previous, ...patch }) as StartNode);
      }}
    />
  );
}

function latest(): Partial<StartNode> | undefined {
  return patches.at(-1);
}

beforeEach(() => {
  patches = [];
});

describe("start node webhook trigger", () => {
  it("writes webhook.enabled when Accept webhook triggers is checked", async () => {
    render(<Harness initial={startNode()} />);
    expect(screen.queryByTestId("inspector-webhook-mapping")).toBeNull();

    const checkbox = screen.getByRole("checkbox", { name: "Accept webhook triggers" });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);

    await waitFor(() => expect(latest()).toEqual({ webhook: { enabled: true } }));
    expect(screen.getByRole("checkbox", { name: "Accept webhook triggers" })).toBeChecked();
    expect(screen.getByTestId("inspector-webhook-mapping")).toBeInTheDocument();
    expect(
      screen.getByText("No rows yet. Every parameter reads its body field."),
    ).toBeInTheDocument();
  });

  it("removes the webhook block when the box is unchecked", async () => {
    render(
      <Harness
        initial={startNode({ webhook: { enabled: true, paramMapping: { topic: "body.topic" } } })}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Accept webhook triggers" }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect("webhook" in (latest() ?? {})).toBe(true);
    expect(latest()?.webhook).toBeUndefined();
    expect(screen.queryByTestId("inspector-webhook-mapping")).toBeNull();
  });

  it("adds a row for the first unmapped parameter as body.<name>, and writes edits to paramMapping", async () => {
    render(<Harness initial={startNode({ webhook: { enabled: true } })} />);

    fireEvent.click(screen.getByTestId("inspector-webhook-mapping-add"));
    await waitFor(() =>
      expect(latest()).toEqual({
        webhook: { enabled: true, paramMapping: { topic: "body.topic" } },
      }),
    );

    fireEvent.change(screen.getByLabelText("Body path for mapping 1"), {
      target: { value: "data.subject" },
    });
    await waitFor(() =>
      expect(latest()).toEqual({
        webhook: { enabled: true, paramMapping: { topic: "body.data.subject" } },
      }),
    );
  });

  it("maps a row to a header from the fixed allowlist", async () => {
    render(
      <Harness
        initial={startNode({ webhook: { enabled: true, paramMapping: { topic: "body.topic" } } })}
      />,
    );

    fireEvent.change(screen.getByLabelText("Source for mapping 1"), {
      target: { value: "header" },
    });
    await waitFor(() =>
      expect(latest()).toEqual({
        webhook: { enabled: true, paramMapping: { topic: "headers.content-type" } },
      }),
    );

    const headers = screen.getByLabelText("Header for mapping 1");
    expect(
      within(headers)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Choose a header",
      "content-type",
      "user-agent",
      "x-github-delivery",
      "x-github-event",
      "x-gitlab-event",
      "x-webhook-id",
    ]);
    fireEvent.change(headers, { target: { value: "x-github-event" } });
    await waitFor(() =>
      expect(latest()).toEqual({
        webhook: { enabled: true, paramMapping: { topic: "headers.x-github-event" } },
      }),
    );
  });

  it("moves a mapping with its parameter when the parameter is renamed, and drops it when removed", async () => {
    render(
      <Harness
        initial={startNode({ webhook: { enabled: true, paramMapping: { topic: "body.topic" } } })}
      />,
    );

    fireEvent.change(screen.getByTestId("inspector-param-0-name"), {
      target: { value: "subject" },
    });
    await waitFor(() =>
      expect(latest()).toMatchObject({
        params: [{ name: "subject" }, { name: "count" }],
        webhook: { enabled: true, paramMapping: { subject: "body.topic" } },
      }),
    );

    fireEvent.click(screen.getByTestId("inspector-param-0-remove"));
    await waitFor(() =>
      expect(latest()).toMatchObject({
        params: [{ name: "count" }],
        webhook: { enabled: true },
      }),
    );
    expect(latest()?.webhook).not.toHaveProperty("paramMapping");
  });

  it("shows E_WEBHOOK_PATH on the path and E_WEBHOOK_MAPPING on the parameter, not in the generic list", () => {
    const issues: Issue[] = [
      {
        severity: "error",
        code: "E_WEBHOOK_PATH",
        message: "Webhook mapping for 'topic' must be body.<path> or headers.<allowlisted name>.",
        pointer: "/graph/nodes/0/webhook/paramMapping/topic",
        nodeId: NODE_ID,
      },
      {
        severity: "error",
        code: "E_WEBHOOK_MAPPING",
        message: "Webhook mapping targets undeclared parameter 'ghost'.",
        pointer: "/graph/nodes/0/webhook/paramMapping/ghost",
        nodeId: NODE_ID,
      },
    ];
    render(
      <Harness
        initial={startNode({
          webhook: { enabled: true, paramMapping: { topic: "body.", ghost: "body.ghost" } },
        })}
        issues={issues}
      />,
    );

    expect(
      screen.getByText(
        "Webhook mapping for 'topic' must be body.<path> or headers.<allowlisted name>.",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("Parameter for mapping 2")).toHaveValue("ghost");
    expect(screen.getByText("ghost (not declared)")).toBeInTheDocument();
    expect(screen.getByText("Webhook mapping targets undeclared parameter 'ghost'.")).toBeVisible();
    expect(screen.queryByTestId("inspector-issues")).toBeNull();
  });
});

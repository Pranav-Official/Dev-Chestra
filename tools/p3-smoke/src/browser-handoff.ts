import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext } from "@playwright/test";
import {
  addNode,
  bootstrapPage,
  connectNodes,
  createBlankWorkflowThroughUi,
  fitView,
  launchBrowser,
  openEditor,
  registerProjectThroughUi,
  runFromEditor,
  saveNow,
  selectNode,
  setAgentCliFake,
  waitRunSucceeded,
  waitSaved,
  waitValidation,
} from "./browser-ui.js";
import { CLI, makeWorkspace } from "./fixtures.js";
import { RelayHttp } from "./http.js";
import { type OwnedServer, shutdownOwned, startSentinel, startServer } from "./owned.js";
import { collectSpawnedAgents } from "./store-read.js";

export interface HandoffEvidence {
  workflowId: string;
  runId: string;
  run202: boolean;
  startNonceInAgent1Prompt: boolean;
  agent1NonceInAgent2Prompt: boolean;
  agent1ReposInAgent2Prompt: boolean;
  derivedReceivedMatchesAgent1: boolean;
  ownProtoRetained: boolean;
  viewerShowsReceived: boolean;
}

const START_NONCE = `start-${randomUUID()}`;
const HANDOFF_NONCE = `handoff-${randomUUID()}`;

function repos(): Array<Record<string, unknown>> {
  return Array.from({ length: 14 }, (_, index) => ({
    name: `repo-${String(index + 1).padStart(2, "0")}`,
    stars: 0,
    fork: false,
    owner: null,
    tags: [`tag-${String(index + 1)}`, "handoff"],
    nested: { rank: index, active: index % 2 === 0, missing: null },
  }));
}

function fallback(): Record<string, unknown> {
  const records = repos();
  const last = records.at(-1);
  assert.ok(last !== undefined);
  Object.defineProperty(last, "__proto__", {
    value: { ownRepoKey: true, values: [0, false, null] },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return { handoffNonce: HANDOFF_NONCE, repos: records };
}

async function writeScript(root: string): Promise<string> {
  const path = join(root, "handoff-fake-script.json");
  const script = [
    {
      type: "submit-from-inputs",
      path: ["agent"],
      fallback: fallback(),
    },
  ];
  await writeFile(path, `${JSON.stringify(script, null, 2)}\n`, "utf8");
  return path;
}

function inputPrompt(
  events: Array<{ path?: unknown; type?: unknown; payload?: unknown }>,
  path: string,
): string {
  const event = events.find((item) => item.type === "node.input.resolved" && item.path === path);
  assert.ok(event !== undefined, `missing node.input.resolved for ${path}`);
  const payload = event.payload as Record<string, unknown> | undefined;
  const inputs = payload?.inputs as Record<string, unknown> | undefined;
  const prompt = inputs?.prompt;
  assert.equal(typeof prompt, "string", `missing recorded prompt for ${path}`);
  return prompt as string;
}

function executionOutput(body: unknown): Record<string, unknown> {
  const record = body as {
    output?: { data?: Record<string, unknown> | null } | null;
  };
  assert.ok(record.output?.data !== undefined && record.output.data !== null);
  return record.output.data;
}

export async function runHandoffBrowserScenario(): Promise<HandoffEvidence> {
  const ws = await makeWorkspace("relay-p3-handoff-");
  const sentinel = startSentinel();
  const script = await writeScript(ws.root);
  let server: OwnedServer | null = null;
  let context: BrowserContext | null = null;
  try {
    server = await startServer({
      cli: CLI,
      dataDir: ws.dataDir,
      cwd: ws.projectDir,
      fakeScript: script,
    });
    const http = new RelayHttp(server.baseUrl);
    await http.health();
    await http.bootstrap(server.meta.token);
    const session = await launchBrowser(ws);
    context = session.context;
    const page = await bootstrapPage(context, server.baseUrl, server.meta.token);
    const projectId = await registerProjectThroughUi(page, ws.projectDir);
    const workflowId = await createBlankWorkflowThroughUi(
      page,
      projectId,
      "Automatic handoff workflow",
      "auto-handoff",
    );
    for (const type of ["start", "agent", "agent", "end"] as const) await addNode(page, type);
    await setAgentCliFake(http, page, projectId, workflowId, "agent");
    await setAgentCliFake(http, page, projectId, workflowId, "agent2");
    await fitView(page);

    await selectNode(page, "start");
    await page.getByTestId("inspector-node-name").fill("Inputs");
    await page.getByTestId("inspector-add-param").click();
    await page.getByTestId("inspector-param-0-name").fill("runToken");
    await page.getByTestId("inspector-param-0-required").check();

    await selectNode(page, "agent");
    await page.getByTestId("inspector-node-name").fill("Source Agent");
    await page
      .getByTestId("inspector-agent-prompt")
      .fill("Collect the repository records for this handoff run.");

    await selectNode(page, "agent2");
    await page.getByTestId("inspector-node-name").fill("Consumer Agent");
    await page
      .getByTestId("inspector-agent-prompt")
      .fill("Use the automatically supplied upstream repository records.");

    await selectNode(page, "end");
    await page.getByTestId("inspector-node-name").fill("Done");
    await page.getByTestId("inspector-end-result").fill('{"nonce": agent2.received.handoffNonce}');

    await connectNodes(page, "start", "agent");
    await connectNodes(page, "agent", "agent2");
    await connectNodes(page, "agent2", "end");
    await page.waitForFunction(
      () => document.querySelectorAll(".react-flow__edge").length === 3,
      undefined,
      { timeout: 10_000 },
    );
    await saveNow(page);
    await waitValidation(page, "Valid");
    await openEditor(page, projectId, workflowId);
    await waitSaved(page);
    await selectNode(page, "agent");
    assert.equal(
      await page.getByTestId("inspector-agent-prompt").inputValue(),
      "Collect the repository records for this handoff run.",
    );
    await selectNode(page, "agent2");
    assert.equal(
      await page.getByTestId("inspector-agent-prompt").inputValue(),
      "Use the automatically supplied upstream repository records.",
    );

    const run = await runFromEditor(page, { runToken: START_NONCE });
    assert.equal(run.responseStatus, 202);
    await waitRunSucceeded(page, 90_000);

    const eventPage = await http.api(
      "GET",
      `/api/runs/${encodeURIComponent(run.runId)}/events?types=node.input.resolved&limit=100`,
    );
    assert.equal(eventPage.status, 200);
    const events = (eventPage.body as { events?: Array<Record<string, unknown>> }).events ?? [];
    const firstPrompt = inputPrompt(events, "agent");
    const secondPrompt = inputPrompt(events, "agent2");
    assert.ok(
      firstPrompt.includes("<relay_input_context>"),
      "Agent1 prompt must include the data block",
    );
    assert.ok(
      firstPrompt.includes("</relay_input_context>"),
      "Agent1 prompt data block must be closed",
    );
    assert.ok(firstPrompt.includes(START_NONCE), "Agent1 prompt must contain Start data");
    assert.ok(!firstPrompt.includes("{{"), "Agent1 prompt must be plain, not a template");
    assert.ok(
      secondPrompt.includes("<relay_input_context>"),
      "Agent2 prompt must include the data block",
    );
    assert.ok(
      secondPrompt.includes("</relay_input_context>"),
      "Agent2 prompt data block must be closed",
    );
    assert.ok(secondPrompt.includes(START_NONCE), "Agent2 prompt must retain Start data");
    assert.ok(
      secondPrompt.includes(HANDOFF_NONCE),
      "Agent2 prompt must contain Agent1 accepted output",
    );
    for (let index = 1; index <= 14; index += 1) {
      assert.ok(
        secondPrompt.includes(`repo-${String(index).padStart(2, "0")}`),
        `Agent2 prompt must contain repository ${String(index)}`,
      );
    }
    assert.ok(!secondPrompt.includes("{{"), "Agent2 prompt must be plain, not a template");

    const firstExecution = await http.api(
      "GET",
      `/api/runs/${encodeURIComponent(run.runId)}/executions/agent`,
    );
    const secondExecution = await http.api(
      "GET",
      `/api/runs/${encodeURIComponent(run.runId)}/executions/agent2`,
    );
    assert.equal(firstExecution.status, 200);
    assert.equal(secondExecution.status, 200);
    const firstOutput = executionOutput(firstExecution.body);
    const secondOutput = executionOutput(secondExecution.body);
    assert.equal(firstOutput.handoffNonce, HANDOFF_NONCE);
    assert.equal((firstOutput.repos as unknown[]).length, 14);
    const firstLast = (firstOutput.repos as Array<Record<string, unknown>>).at(-1);
    assert.ok(firstLast !== undefined);
    assert.equal(Object.hasOwn(firstLast, "__proto__"), true);
    assert.deepEqual(secondOutput.received, firstOutput);
    assert.equal((secondOutput.received as Record<string, unknown>).handoffNonce, HANDOFF_NONCE);

    await page.getByTestId("run-node-agent2").click();
    const viewer = (await page.getByTestId("detail-output").textContent()) ?? "";
    assert.match(viewer, new RegExp(HANDOFF_NONCE, "u"));
    assert.match(viewer, /repo-14/u);

    return {
      workflowId,
      runId: run.runId,
      run202: run.responseStatus === 202,
      startNonceInAgent1Prompt: true,
      agent1NonceInAgent2Prompt: true,
      agent1ReposInAgent2Prompt: true,
      derivedReceivedMatchesAgent1: true,
      ownProtoRetained: true,
      viewerShowsReceived: true,
    };
  } finally {
    if (context !== null) await context.close().catch(() => undefined);
    if (server !== null) {
      const agents = collectSpawnedAgents(ws.dataDir);
      await shutdownOwned({ server, agents, sentinel, keep: false, dataDir: ws.root });
    } else {
      sentinel.kill("SIGKILL");
    }
  }
}

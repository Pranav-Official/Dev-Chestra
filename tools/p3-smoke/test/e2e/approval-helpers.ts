import assert from "node:assert/strict";
import { fitView, saveNow } from "../../src/browser-ui.js";
import type { RelayHttp } from "../../src/http.js";
import { getWorkflow } from "../../src/workflow-api.js";

export async function connectHandles(
  page: import("@playwright/test").Page,
  fromTestId: string,
  toTestId: string,
) {
  await fitView(page);
  const from = page.getByTestId(fromTestId).first();
  const to = page.getByTestId(toTestId).first();
  try {
    await from.waitFor({ state: "attached", timeout: 15_000 });
  } catch (e) {
    const handles = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="ed-handle-"]')]
        .map((el) => el.getAttribute("data-testid"))
        .join(","),
    );
    const nodes = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="ed-node-"]')]
        .map((el) => el.getAttribute("data-testid"))
        .join(","),
    );
    const all = await page.evaluate(() =>
      [...document.querySelectorAll("[data-testid]")]
        .map((el) => el.getAttribute("data-testid"))
        .slice(0, 50)
        .join(","),
    );
    throw new Error(
      `selector ${fromTestId} not attached. handles:${handles} nodes:${nodes} all:${all.slice(0, 800)}`,
      { cause: e },
    );
  }
  try {
    await to.waitFor({ state: "attached", timeout: 15_000 });
  } catch (e) {
    const handles = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="ed-handle-"]')]
        .map((el) => el.getAttribute("data-testid"))
        .join(","),
    );
    throw new Error(`selector ${toTestId} not attached. handles:${handles}`, { cause: e });
  }
  await from.scrollIntoViewIfNeeded();
  await to.scrollIntoViewIfNeeded();
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  assert.ok(a && b, `${fromTestId} -> ${toTestId} handles not visible`);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 });
  await page.mouse.up();
}

export async function connectAndAssert(
  page: import("@playwright/test").Page,
  http: RelayHttp,
  projectId: string,
  workflowId: string,
  fromTestId: string,
  toTestId: string,
  expectedFrom: string,
  expectedTo: string,
  expectedCount: number,
) {
  await connectHandles(page, fromTestId, toTestId);
  await page.waitForFunction(
    (exp) => document.querySelectorAll(".react-flow__edge").length === exp,
    expectedCount,
    { timeout: 15_000 },
  );
  let after = await getWorkflow(http, projectId, workflowId);
  let edges = after.workflow.graph.edges as Array<{ from: string; to: string }>;
  if (
    !edges.some((e) => e.from === expectedFrom && e.to === expectedTo) ||
    edges.length !== expectedCount
  ) {
    await saveNow(page);
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      after = await getWorkflow(http, projectId, workflowId);
      edges = after.workflow.graph.edges as Array<{ from: string; to: string }>;
      if (
        edges.some((e) => e.from === expectedFrom && e.to === expectedTo) &&
        edges.length === expectedCount
      )
        break;
    }
  }
  assert.equal(
    edges.length,
    expectedCount,
    `edge count after ${expectedFrom}->${expectedTo} must be ${expectedCount}, got ${edges.length} edges=${edges.map((e) => `${e.from}->${e.to}`).join(",")} domEdges=${await page.evaluate(() => document.querySelectorAll(".react-flow__edge").length)}`,
  );
  assert.ok(
    edges.some((e) => e.from === expectedFrom && e.to === expectedTo),
    `expected edge ${expectedFrom}->${expectedTo} missing in ${edges.map((e) => `${e.from}->${e.to}`).join(",")}`,
  );
}

export function raiseCleanup(failure: unknown, failures: unknown[], label: string): void {
  if (failure !== undefined && failures.length > 0)
    throw new AggregateError([failure, ...failures], label);
  if (failure !== undefined) throw failure;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, label);
}

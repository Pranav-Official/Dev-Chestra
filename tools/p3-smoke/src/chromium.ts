import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Page } from "@playwright/test";

const require = createRequire(import.meta.url);

export function chromiumPath(): string {
  const configured = process.env.RELAY_CHROMIUM_PATH;
  if (configured !== undefined && configured !== "") return configured;
  return "/usr/bin/chromium";
}

export async function injectAxe(page: Page): Promise<void> {
  const source = await readFile(require.resolve("axe-core/axe.min.js"), "utf8");
  await page.evaluate(source);
}

export interface AxeNode {
  target?: string[];
  html?: string;
  failureSummary?: string;
}

export interface AxeViolation {
  id: string;
  impact: string | null;
  nodes: AxeNode[];
}

export async function axeRun(page: Page): Promise<{ violations: AxeViolation[] }> {
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe?: { run: (root: Document) => Promise<{ violations: AxeViolation[] }> };
      }
    ).axe;
    if (axe === undefined) throw new Error("axe-core was not injected");
    return axe.run(document);
  });
}

export function seriousViolations(result: { violations: AxeViolation[] }): {
  count: number;
  ids: Array<{
    id: string;
    impact: string | null;
    nodes: number;
    targets: string[];
    summaries: string[];
  }>;
} {
  const serious = result.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  return {
    count: serious.length,
    ids: serious.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.length,
      targets: violation.nodes.flatMap((node) => node.target ?? []),
      summaries: violation.nodes.map((node) => node.failureSummary ?? "").filter(Boolean),
    })),
  };
}

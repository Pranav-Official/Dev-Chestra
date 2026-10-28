import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const FIXTURE_ROOT = join(REPO_ROOT, "tools/fixtures/p2");
export const CLI = join(REPO_ROOT, "packages/cli/dist/main.js");
export const WEB_INDEX_CANDIDATES = [
  join(REPO_ROOT, "apps/web/dist/index.html"),
  join(REPO_ROOT, "packages/web/dist/index.html"),
];

export interface Workspace {
  root: string;
  projectDir: string;
  dataDir: string;
  workflowPath: string;
  workflowFile: string;
}

export async function makeWorkspace(prefix = "relay-p2-"): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  if (root.startsWith(REPO_ROOT)) {
    throw new Error("P2 smoke must not create workspaces inside the repository");
  }
  const projectDir = join(root, "project");
  const dataDir = join(root, "data");
  await mkdir(projectDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const workflowFile = "p2-basic.json";
  const workflowPath = join(projectDir, workflowFile);
  await copyFile(join(FIXTURE_ROOT, "workflows", workflowFile), workflowPath);
  return { root, projectDir, dataDir, workflowPath, workflowFile };
}

export function scriptPath(name: "basic" | "slow" | "browser" | "html" | "hold"): string {
  return join(FIXTURE_ROOT, "scripts", `${name}.json`);
}

export interface ManyWorkflow {
  file: string;
  path: string;
  shellNodes: number;
}

/**
 * A long linear chain of real shell nodes. Each shell node emits roughly ten
 * durable events in the current engine, so this is a deterministic way to get
 * a >500-event backlog without paid model turns or synthetic route mocks.
 */
export async function writeManyWorkflow(
  projectDir: string,
  shellNodes: number,
): Promise<ManyWorkflow> {
  if (!Number.isSafeInteger(shellNodes) || shellNodes < 1 || shellNodes > 200) {
    throw new Error("shellNodes must be 1..200");
  }
  const nodes: Record<string, unknown>[] = [
    { id: "start", type: "start", name: "Start", params: [], ui: { x: 0, y: 0 } },
  ];
  for (let index = 0; index < shellNodes; index += 1) {
    const id = `s${String(index).padStart(3, "0")}`;
    nodes.push({
      id,
      type: "shell",
      name: `Step ${String(index + 1)}`,
      command: "true",
      workspace: { mode: "scratch" },
      timeoutMin: 1,
      allowFailure: false,
      ui: { x: 200 + index * 40, y: 0 },
    });
  }
  nodes.push({
    id: "done",
    type: "end",
    name: "Done",
    status: "success",
    result: "true",
    ui: { x: 200 + shellNodes * 40, y: 0 },
  });
  const edges = nodes.slice(0, -1).map((node, index) => ({
    id: `e-${String(index)}`,
    from: node.id,
    to: nodes[index + 1]?.id,
  }));
  const file = "p2-many.json";
  const path = join(projectDir, file);
  await writeFile(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: "p2-many",
        name: "P2 many-event chain",
        description: "Deterministic backlog fixture; shell nodes only, no provider calls.",
        graph: { nodes, edges },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { file, path, shellNodes };
}

export async function readFixture<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function webIndexExists(candidates = WEB_INDEX_CANDIDATES): Promise<boolean> {
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return true;
    } catch {
      // Keep looking.
    }
  }
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

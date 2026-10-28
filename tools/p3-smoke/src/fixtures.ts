import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const FIXTURE_ROOT = join(REPO_ROOT, "tools/fixtures/p3");
export const CLI = join(REPO_ROOT, "packages/cli/dist/main.js");
export const WEB_INDEX = join(REPO_ROOT, "apps/web/dist/index.html");
export const MCP_SHIM = join(REPO_ROOT, "packages/mcp/dist/bin/shim.js");
export const FAKE_AGENT = join(REPO_ROOT, "tools/fake-agent/dist/main.js");

export interface Workspace {
  root: string;
  projectDir: string;
  dataDir: string;
  profileDir: string;
}

export async function makeWorkspace(prefix = "relay-p3-"): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  if (root.startsWith(REPO_ROOT)) {
    throw new Error("P3 smoke must not create workspaces inside the repository");
  }
  const projectDir = join(root, "project");
  const dataDir = join(root, "data");
  const profileDir = join(root, "profile");
  await mkdir(projectDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  return { root, projectDir, dataDir, profileDir };
}

export function scriptPath(name: "summary" | "slow" | "raw"): string {
  return join(FIXTURE_ROOT, "scripts", `${name}.json`);
}

export function workflowFixturePath(name: "p3-linear" | "p3-incomplete"): string {
  return join(FIXTURE_ROOT, "workflows", `${name}.json`);
}

export async function copyFixture(
  projectDir: string,
  name: "p3-linear" | "p3-incomplete",
  target = `${name}.json`,
): Promise<string> {
  const destination = join(projectDir, target);
  await copyFile(workflowFixturePath(name), destination);
  return target;
}

export async function readFixture<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

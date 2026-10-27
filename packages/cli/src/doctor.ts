import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, type Store } from "@relay/store";
import {
  acquireDataDirLock,
  DataDirLockedError,
  inspectDataDirLock,
  type LockHandle,
} from "./lock.js";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SHIM = join(REPO_ROOT, "packages/mcp/dist/bin/shim.js");
const FAKE_AGENT = join(REPO_ROOT, "tools/fake-agent/dist/main.js");

function nodeMajor(): number {
  const major = Number(process.versions.node.split(".")[0]);
  return Number.isSafeInteger(major) ? major : 0;
}

async function checkDataDir(dataDir: string): Promise<DoctorCheck> {
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const probe = join(dataDir, `.relay-doctor-${randomBytes(6).toString("hex")}`);
    await writeFile(probe, "ok\n", { mode: 0o600 });
    await rm(probe, { force: true });
    return { name: "data-dir", status: "pass", message: `${dataDir} is writable` };
  } catch (error) {
    return {
      name: "data-dir",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
      fix: "Use an explicit writable --data-dir (not ~/.relay in this milestone).",
    };
  }
}

function checkStore(store: Store): DoctorCheck[] {
  const checks: DoctorCheck[] = [
    {
      name: "sqlite",
      status: "pass",
      message: "SQLite opened; migrations and FTS5 check passed",
    },
  ];
  try {
    const active = store.runs.listActive();
    checks.push(
      active.length === 0
        ? { name: "open-runs", status: "pass", message: "no open runs" }
        : {
            name: "open-runs",
            status: "warn",
            message: `${active.length} open run(s): ${active.map((run) => run.id).join(", ")}`,
            fix: "Run `relay resume <runId> --data-dir <dir>` to recover.",
          },
    );
  } catch (error) {
    checks.push({
      name: "open-runs",
      status: "warn",
      message: `could not list runs: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  try {
    const processes = store.processes.active();
    checks.push(
      processes.length === 0
        ? { name: "processes", status: "pass", message: "no recorded active process groups" }
        : {
            name: "processes",
            status: "warn",
            message: `${processes.length} recorded active process group(s)`,
            fix: "Resume the run; boot recovery verifies pidStart before killing orphans.",
          },
    );
  } catch (error) {
    checks.push({
      name: "processes",
      status: "warn",
      message: `could not inspect processes: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return checks;
}

export async function runDoctor(dataDir: string): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const major = nodeMajor();
  checks.push(
    major >= 22
      ? { name: "node", status: "pass", message: `Node ${process.versions.node}` }
      : {
          name: "node",
          status: "fail",
          message: `Node ${process.versions.node} is too old`,
          fix: "Install Node >= 22.",
        },
  );
  checks.push(await checkDataDir(dataDir));
  const inspection = await inspectDataDirLock(dataDir);
  if (inspection.locked) {
    checks.push(
      inspection.ambiguous
        ? {
            name: "lock",
            status: "fail",
            message: "data-dir lock has no readable owner",
            fix: "Inspect relay.lock; remove it only after confirming no Relay process is running.",
          }
        : inspection.live
          ? {
              name: "lock",
              status: "fail",
              message: `data directory is in use by pid ${inspection.owners.map((owner) => owner.pid).join(", ")}`,
              fix: "Stop the other Relay process or use a different --data-dir.",
            }
          : {
              name: "lock",
              status: "warn",
              message: "stale data-dir lock (owner process is not alive)",
              fix: "Run `relay run`/`relay resume`; acquisition will reclaim it. Doctor does not delete it.",
            },
    );
    checks.push({
      name: "sqlite",
      status: "warn",
      message: "skipped because the data-dir lock is not free (no stale reclaim by doctor)",
    });
    return { ok: checks.every((check) => check.status !== "fail"), checks };
  }

  let lock: LockHandle;
  try {
    lock = await acquireDataDirLock(dataDir, "0.1.0", { allowStaleReclaim: false });
  } catch (error) {
    checks.push({
      name: "lock",
      status: "warn",
      message:
        error instanceof DataDirLockedError
          ? "lock changed while doctor was starting; store inspection skipped"
          : error instanceof Error
            ? error.message
            : String(error),
    });
    checks.push({ name: "sqlite", status: "warn", message: "skipped because the lock changed" });
    return { ok: checks.every((check) => check.status !== "fail"), checks };
  }
  checks.push({
    name: "lock",
    status: "pass",
    message: "diagnostic lock acquired (no stale reclaim)",
  });

  checks.push(
    existsSync(SHIM)
      ? { name: "mcp-shim", status: "pass", message: SHIM }
      : {
          name: "mcp-shim",
          status: "fail",
          message: `missing ${SHIM}`,
          fix: "Run `pnpm -r build`.",
        },
  );
  checks.push(
    existsSync(FAKE_AGENT)
      ? { name: "fake-agent", status: "pass", message: FAKE_AGENT }
      : {
          name: "fake-agent",
          status: "fail",
          message: `missing ${FAKE_AGENT}`,
          fix: "Run `pnpm -r build`.",
        },
  );

  let store: Store | undefined;
  try {
    store = openStore({ file: join(dataDir, "relay.db") });
    checks.push({
      name: "sqlite",
      status: "pass",
      message: "SQLite opened; migrations and FTS5 check passed (bounded diagnostic side effect)",
    });
    checks.push(...checkStore(store));
  } catch (error) {
    checks.push({
      name: "sqlite",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
      fix: "Check the data directory and SQLite installation.",
    });
  } finally {
    store?.close();
    await lock.release();
  }

  return { ok: checks.every((check) => check.status !== "fail"), checks };
}

export function printDoctor(result: DoctorResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ type: "doctor", ...result })}\n`);
    return;
  }
  for (const check of result.checks) {
    process.stdout.write(`[${check.status}] ${check.name}: ${check.message}\n`);
    if (check.fix !== undefined) {
      process.stdout.write(`       fix: ${check.fix}\n`);
    }
  }
  process.stdout.write(result.ok ? "doctor: ok\n" : "doctor: failed\n");
}

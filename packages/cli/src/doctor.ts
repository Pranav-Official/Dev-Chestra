import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDecisionService,
  type DecisionService,
  decisionProviders,
  type TestReport,
} from "@devchestra/decisions";
import { DECISION_PROVIDER_LABELS } from "@devchestra/schema";
import { openStore, type Store } from "@devchestra/store";
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
    const probe = join(dataDir, `.devchestra-doctor-${randomBytes(6).toString("hex")}`);
    await writeFile(probe, "ok\n", { mode: 0o600 });
    await rm(probe, { force: true });
    return { name: "data-dir", status: "pass", message: `${dataDir} is writable` };
  } catch (error) {
    return {
      name: "data-dir",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
      fix: "Use an explicit writable --data-dir.",
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
            fix: "Run `devchestra resume <runId> --data-dir <dir>` to recover.",
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

function checkDecisionProviders(service: DecisionService): DoctorCheck[] {
  // Readiness only: missing entries name the VARIABLES, never their values.
  return decisionProviders().map((id) => {
    const availability = service.client(id).availability();
    if (availability.ready) {
      return {
        name: `decision-${id}`,
        status: "pass" as const,
        message: `${DECISION_PROVIDER_LABELS[id]} is ready`,
      };
    }
    return {
      name: `decision-${id}`,
      status: "warn" as const,
      message: `${DECISION_PROVIDER_LABELS[id]} is not configured: missing ${availability.missing.join(", ")}`,
      fix: "Set the named variables in the environment, in a `.env` in the folder you run `devchestra` from, or in `~/.config/devchestra/.env` (see `.env.example`).",
    };
  });
}

export interface DoctorOptions {
  /**
   * When true, send ONE tiny live request per ready decision provider via the
   * client's `test()` and report the redacted shape. Costs tokens. Default
   * false, in which case doctor makes no network calls at all.
   */
  probeDecisions?: boolean;
  /** Test seam: stand-in-backed service. Defaults to the live service. */
  decisions?: DecisionService;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

/** Redacted one-line shape: key names and value types only, never values. */
function shapeText(report: TestReport): string {
  const shape = report.shape;
  if (shape === undefined) return "shape=unavailable";
  const types = Object.entries(shape.answerValueTypes)
    .map(([key, type]) => `${key}:${type}`)
    .join(",");
  return (
    `wrapped=${yesNo(shape.wrappedInResult)} ` +
    `top=[${shape.topLevelKeys.join(",")}] ` +
    `answer=[${shape.answerKeys.join(",")}] ` +
    `types={${types}} ` +
    `confidence=${yesNo(shape.hasConfidence)} ` +
    `probabilities=${yesNo(shape.hasProbabilities)} ` +
    `usage=${yesNo(shape.hasUsage)}`
  );
}

async function probeDecisionProviders(service: DecisionService): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const id of decisionProviders()) {
    if (!service.client(id).availability().ready) continue;
    let report: TestReport;
    try {
      // One trivial boolean question per ready provider (costs tokens).
      report = await service.client(id).test(new AbortController().signal);
    } catch {
      // `test()` reports provider failures as ok:false; a throw is a bug,
      // so keep the message generic rather than risk leaking internals.
      report = { ok: false, provider: id, model: "unknown", latencyMs: 0 };
    }
    const label = DECISION_PROVIDER_LABELS[id];
    if (report.ok) {
      checks.push({
        name: `decision-probe-${id}`,
        status: "pass",
        message:
          `${label} probe ok in ${report.latencyMs}ms ` +
          `model=${report.resolvedModel ?? report.model} ${shapeText(report)}`,
      });
    } else {
      checks.push({
        name: `decision-probe-${id}`,
        status: "fail",
        message:
          `${label} probe failed in ${report.latencyMs}ms model=${report.model}` +
          (report.error === undefined ? "" : `: ${report.error}`),
        fix: "Check the provider key, account id and network, then rerun with --probe-decisions.",
      });
    }
  }
  return checks;
}

export async function runDoctor(
  dataDir: string,
  options: DoctorOptions = {},
): Promise<DoctorResult> {
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
            fix: "Inspect devchestra.lock; remove it only after confirming no DevChestra process is running.",
          }
        : inspection.live
          ? {
              name: "lock",
              status: "fail",
              message: `data directory is in use by pid ${inspection.owners.map((owner) => owner.pid).join(", ")}`,
              fix: "Stop the other DevChestra process or use a different --data-dir.",
            }
          : {
              name: "lock",
              status: "warn",
              message: "stale data-dir lock (owner process is not alive)",
              fix: "Run `devchestra run`/`devchestra resume`; acquisition will reclaim it. Doctor does not delete it.",
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
  checks.push(...checkDecisionProviders(options.decisions ?? createDecisionService()));

  let store: Store | undefined;
  try {
    store = openStore({ file: join(dataDir, "devchestra.db") });
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

  if (options.probeDecisions === true) {
    checks.push(...(await probeDecisionProviders(options.decisions ?? createDecisionService())));
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

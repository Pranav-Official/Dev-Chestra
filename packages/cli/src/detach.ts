import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { serverStatus } from "./server-control.js";

export interface DetachStartDeps {
  spawnImpl?: typeof spawn;
  statusImpl?: typeof serverStatus;
  sleepMs?: (ms: number) => Promise<void>;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  timeoutMs?: number;
}

const sleepDefault = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Launch `devchestra start` (minus --detach/-d) as a detached background
 * process, wait until its server record verifies, then exit. Logs append to
 * `<dataDir>/server.log` since the child shares no terminal.
 */
export async function detachStart(
  dataDir: string,
  options: { json?: boolean },
  deps: DetachStartDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const statusImpl = deps.statusImpl ?? serverStatus;
  const sleep = deps.sleepMs ?? sleepDefault;
  const timeoutMs = deps.timeoutMs ?? 15_000;

  mkdirSync(dataDir, { recursive: true });

  const before = await statusImpl(dataDir);
  if (before.state === "running") {
    if (options.json === true) {
      stdout.write(
        `${JSON.stringify({ type: "start", detached: true, alreadyRunning: true, ...before })}\n`,
      );
    } else {
      stdout.write(`devchestra: already running at ${before.url}\n`);
    }
    return 0;
  }

  const script = process.argv[1];
  if (script === undefined) {
    stderr.write("devchestra: cannot detach: script path is unknown\n");
    return 1;
  }
  const childArgs = process.argv.slice(2).filter((arg) => arg !== "--detach" && arg !== "-d");

  const logFile = join(dataDir, "server.log");
  const logFd = openSync(logFile, "a");
  try {
    const spawnImpl = deps.spawnImpl ?? spawn;
    const child = spawnImpl(process.execPath, [script, ...childArgs], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.on("error", () => undefined);
    child.unref();
  } finally {
    closeSync(logFd);
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await statusImpl(dataDir);
    if (status.state === "running") {
      if (options.json === true) {
        stdout.write(`${JSON.stringify({ type: "start", detached: true, ...status, logFile })}\n`);
      } else {
        stdout.write(`devchestra: running at ${status.url} (pid ${status.pid})\n`);
        stdout.write(`devchestra: logs at ${logFile}\n`);
      }
      return 0;
    }
    if (Date.now() >= deadline) {
      stderr.write(
        `devchestra: server did not report ready within ${Math.round(timeoutMs / 1000)}s; see ${logFile}\n`,
      );
      return 1;
    }
    await sleep(150);
  }
}

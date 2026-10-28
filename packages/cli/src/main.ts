import { resolve } from "node:path";
import { type CliOptions, HELP, parseArgs, UsageError } from "./args.js";
import { executeResume, executeRun } from "./commands.js";
import { printDoctor, runDoctor } from "./doctor.js";
import { acquireDataDirLock, DataDirLockedError, type LockHandle } from "./lock.js";
import { exitCodeForError, safeError, writeSummary } from "./output.js";
import { executeStart } from "./start.js";

const VERSION = "0.1.0";

function versionLine(): string {
  return `devchestra ${VERSION} node ${process.versions.node} ${process.platform}/${process.arch}`;
}

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`devchestra: ${error.message}\n\n${HELP}`);
      return 4;
    }
    throw error;
  }

  if (options.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.command === "version") {
    process.stdout.write(`${versionLine()}\n`);
    return 0;
  }

  for (const flag of options.deprecatedFlags ?? []) {
    process.stderr.write(
      `note: ${flag} is deprecated and has no effect; all adapters are official.\n`,
    );
  }
  const dataDir = resolve(options.dataDir ?? "");
  if (options.command === "doctor") {
    const result = await runDoctor(dataDir, { probeDecisions: options.probeDecisions });
    printDoctor(result, options.json);
    return result.ok ? 0 : 1;
  }

  if (options.command === "start") {
    const controller = new AbortController();
    const onSignal = (): void => {
      controller.abort();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      return await executeStart(options, dataDir, {
        signal: controller.signal,
        version: VERSION,
      });
    } catch (error) {
      if (error instanceof UsageError) {
        process.stderr.write(`devchestra: ${error.message}\n`);
        return 4;
      }
      const safe = safeError(error);
      process.stderr.write(`devchestra: ${safe.code}: ${safe.message}\n`);
      return exitCodeForError(error);
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }

  let lock: LockHandle;
  try {
    lock = await acquireDataDirLock(dataDir, VERSION);
  } catch (error) {
    if (error instanceof DataDirLockedError) {
      process.stderr.write(`devchestra: ${error.message}\n`);
      return 4;
    }
    throw error;
  }

  try {
    if (options.command === "run") {
      return await executeRun(options, dataDir);
    }
    return await executeResume(options, dataDir);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`devchestra: ${error.message}\n`);
      return 4;
    }
    const safe = safeError(error);
    const exitCode = exitCodeForError(error);
    writeSummary({ status: "failed", error: safe, exitCode }, options.json);
    process.stderr.write(`devchestra: ${safe.code}: ${safe.message}\n`);
    return exitCode;
  } finally {
    await lock.release();
  }
}

const code = await main();
process.exitCode = code;

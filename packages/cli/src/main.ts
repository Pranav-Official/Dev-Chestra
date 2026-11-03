#!/usr/bin/env node
import { resolve } from "node:path";
import { ApiError, ApiTransportError } from "@devchestra/api";
import { isSkillName, projectSkillTemplate, skillMenu, skillTemplate } from "@devchestra/server";
import {
  AgentCommandError,
  AgentUsageError,
  capabilities,
  executeAgentCommands,
} from "./agent-commands.js";
import { type CliOptions, HELP, parseArgs, UsageError } from "./args.js";
import { executeResume, executeRun } from "./commands.js";
import { detachStart } from "./detach.js";
import { printDoctor, runDoctor } from "./doctor.js";
import { acquireDataDirLock, DataDirLockedError, type LockHandle } from "./lock.js";
import { exitCodeForError, safeError, writeSummary } from "./output.js";
import { runStatus, runStop } from "./server-commands.js";
import { executeStart } from "./start.js";

const VERSION = "0.1.0";

function versionLine(): string {
  return `devchestra ${VERSION} node ${process.versions.node} ${process.platform}/${process.arch}`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "capabilities") {
    process.stdout.write(`${JSON.stringify(capabilities())}\n`);
    return 0;
  }
  if (argv[0] === "skill") {
    const rest = argv.slice(1);
    if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
      process.stdout.write(skillMenu());
      return 0;
    }
    if (rest[0] === "--all") {
      process.stdout.write(projectSkillTemplate());
      return 0;
    }
    const name = rest[0] ?? "";
    if (rest.length > 1 || !isSkillName(name)) {
      process.stderr.write(
        `devchestra: unknown skill '${name}'. Run 'devchestra skill' to list skills.\n`,
      );
      return 4;
    }
    process.stdout.write(skillTemplate(name));
    return 0;
  }
  const agentGroups = ["project", "workflow", "approval", "providers", "gate", "decision"];
  const runActions = [
    "start",
    "list",
    "show",
    "status",
    "watch",
    "events",
    "execution",
    "context",
    "archive",
    "restore",
    "transcript",
    "output",
    "children",
    "foreach",
    "usage",
    "cancel",
    "resume",
  ];
  if (
    agentGroups.includes(argv[0] ?? "") ||
    (argv[0] === "run" && runActions.includes(argv[1] ?? ""))
  ) {
    try {
      return await executeAgentCommands(argv);
    } catch (error) {
      const code =
        error instanceof AgentCommandError
          ? error.code
          : error instanceof ApiError
            ? error.code
            : error instanceof AgentUsageError ||
                error instanceof SyntaxError ||
                (error instanceof Error && error.name === "ZodError")
              ? "E_VALIDATION"
              : error instanceof ApiTransportError
                ? "E_TRANSPORT"
                : error instanceof Error && error.name === "AbortError"
                  ? "E_TIMEOUT"
                  : safeError(error).code;
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        error instanceof AgentCommandError
          ? error.retryable
          : error instanceof ApiTransportError ||
            (error instanceof ApiError && error.status >= 500);
      const details =
        error instanceof ApiError || error instanceof AgentCommandError ? error.details : undefined;
      const hint =
        error instanceof AgentCommandError
          ? error.hint
          : code === "E_TRANSPORT"
            ? "Inspect the run and reconnect using the last event ID."
            : code === "E_TIMEOUT"
              ? "Inspect the run or reconnect with a longer timeout."
              : undefined;
      process.stderr.write(
        `${JSON.stringify({ contractVersion: 1, error: { code, message, ...(details === undefined ? {} : { details }), retryable, ...(hint === undefined ? {} : { hint }) } })}\n`,
      );
      return code === "E_VALIDATION" ||
        code === "E_NOT_FOUND" ||
        (error instanceof ApiError && error.status < 500)
        ? 4
        : 1;
    }
  }
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
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ contractVersion: 1, version: VERSION, node: process.versions.node })}\n`
        : `${versionLine()}\n`,
    );
    return 0;
  }

  for (const flag of options.deprecatedFlags ?? []) {
    process.stderr.write(
      `note: ${flag} is deprecated and has no effect; all adapters are official.\n`,
    );
  }
  const dataDir = resolve(options.dataDir ?? "");
  if (options.command === "status") {
    return await runStatus(dataDir, options.json);
  }
  if (options.command === "stop") {
    return await runStop(dataDir, {
      force: options.force === true,
      timeoutMs: (options.timeoutSecs ?? 15) * 1000,
      json: options.json,
    });
  }
  if (options.command === "doctor") {
    const result = await runDoctor(dataDir, { probeDecisions: options.probeDecisions });
    printDoctor(result, options.json);
    return result.ok ? 0 : 1;
  }

  if (options.command === "start") {
    if (options.foreground !== true) {
      return await detachStart(dataDir, { json: options.json });
    }
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

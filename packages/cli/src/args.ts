import { isFakeCliEnabled } from "@devchestra/schema";
import { defaultDataDir } from "./data-dir.js";

export type CommandName =
  | "run"
  | "resume"
  | "start"
  | "stop"
  | "status"
  | "doctor"
  | "version"
  | "help";

export interface CliOptions {
  command: CommandName;
  workflow?: string;
  runId?: string;
  project?: string;
  dataDir?: string;
  params: Record<string, unknown>;
  json: boolean;
  nonInteractive: boolean;
  retryUncertainShell: boolean;
  /** Deprecated flags that were passed, so the entry point can print one notice. */
  deprecatedFlags?: string[];
  workspaceMode?: "project" | "new-worktree" | "existing-worktree";
  worktreePath?: string;
  fakeScript?: string;
  port?: number;
  noOpen: boolean;
  headless?: boolean;
  detach?: boolean;
  secure?: boolean;
  printUrl: boolean;
  /** Stop only: stop even with active runs, and SIGKILL if the server will not exit. */
  force?: boolean;
  /** Stop only: seconds to wait for a clean exit (default 15). */
  timeoutSecs?: number;
  /** Doctor only: probe each ready decision provider with one live request. */
  probeDecisions: boolean;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Test-only seam: the fake agent script is invisible unless explicitly enabled. */
export function isFakeScriptEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isFakeCliEnabled(env);
}

function takeValue(argv: string[], index: number, flag: string): { value: string; next: number } {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value.`);
  }
  return { value, next: index + 1 };
}

function parseParam(raw: string): [string, unknown] {
  const equals = raw.indexOf("=");
  if (equals <= 0) {
    throw new UsageError("--param must be key=value.");
  }
  const key = raw.slice(0, equals);
  const text = raw.slice(equals + 1);
  if (key.trim() === "") {
    throw new UsageError("--param key cannot be empty.");
  }
  try {
    return [key, JSON.parse(text) as unknown];
  } catch {
    return [key, text];
  }
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: "help",
    params: {},
    json: false,
    nonInteractive: false,
    retryUncertainShell: false,
    noOpen: false,
    printUrl: false,
    probeDecisions: false,
  };
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.command = "help";
      return options;
    }
    if (arg === "--version") {
      options.command = "version";
      return options;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--non-interactive") {
      options.nonInteractive = true;
      continue;
    }
    if (arg === "--retry-uncertain-shell" || arg === "--retry-uncertain") {
      options.retryUncertainShell = true;
      continue;
    }
    if (arg === "--allow-experimental-adapters") {
      options.deprecatedFlags = [
        ...(options.deprecatedFlags ?? []),
        "--allow-experimental-adapters",
      ];
      continue;
    }
    if (arg === "--headless") {
      options.headless = true;
      options.noOpen = true;
      continue;
    }
    if (arg === "--detach" || arg === "-d") {
      options.detach = true;
      continue;
    }
    if (arg === "--secure") {
      options.secure = true;
      continue;
    }
    if (arg === "--no-open") {
      options.noOpen = true;
      continue;
    }
    if (arg === "--print-url") {
      options.printUrl = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--timeout") {
      const taken = takeValue(argv, index, arg);
      if (!/^\d+$/.test(taken.value) || Number(taken.value) < 1 || Number(taken.value) > 600) {
        throw new UsageError("--timeout must be a whole number of seconds from 1 to 600.");
      }
      options.timeoutSecs = Number(taken.value);
      index = taken.next;
      continue;
    }
    if (arg === "--probe-decisions") {
      options.probeDecisions = true;
      continue;
    }
    if (arg === "--port") {
      const taken = takeValue(argv, index, arg);
      if (!/^\d+$/.test(taken.value)) {
        throw new UsageError("--port must be an integer between 0 and 65535.");
      }
      const port = Number(taken.value);
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
        throw new UsageError("--port must be an integer between 0 and 65535.");
      }
      options.port = port;
      index = taken.next;
      continue;
    }
    if (arg === "--data-dir") {
      const taken = takeValue(argv, index, arg);
      options.dataDir = taken.value;
      index = taken.next;
      continue;
    }
    if (arg === "--project") {
      const taken = takeValue(argv, index, arg);
      options.project = taken.value;
      index = taken.next;
      continue;
    }
    if (arg === "--workspace") {
      const taken = takeValue(argv, index, arg);
      if (
        taken.value !== "project" &&
        taken.value !== "new-worktree" &&
        taken.value !== "existing-worktree"
      ) {
        throw new UsageError("--workspace must be project, new-worktree or existing-worktree.");
      }
      options.workspaceMode = taken.value;
      index = taken.next;
      continue;
    }
    if (arg === "--worktree-path") {
      const taken = takeValue(argv, index, arg);
      options.worktreePath = taken.value;
      index = taken.next;
      continue;
    }
    if (arg === "--param") {
      const taken = takeValue(argv, index, arg);
      const [key, value] = parseParam(taken.value);
      options.params[key] = value;
      index = taken.next;
      continue;
    }
    if (arg === "--fake-script") {
      if (!isFakeScriptEnabled()) {
        throw new UsageError("--fake-script is test-only (DEVCHESTRA_ALLOW_FAKE=1).");
      }
      const taken = takeValue(argv, index, arg);
      options.fakeScript = taken.value;
      index = taken.next;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new UsageError(`Unknown option: ${arg}`);
    }
    positionals.push(arg);
  }

  const command = positionals.shift();
  if (command === "run") {
    options.command = "run";
    const workflow = positionals.shift();
    if (workflow === undefined) {
      throw new UsageError("run requires a workflow path.");
    }
    options.workflow = workflow;
  } else if (command === "resume") {
    options.command = "resume";
    const runId = positionals.shift();
    if (runId === undefined) {
      throw new UsageError("resume requires a run id.");
    }
    options.runId = runId;
  } else if (command === "start") {
    options.command = "start";
  } else if (command === "stop") {
    options.command = "stop";
  } else if (command === "status") {
    options.command = "status";
  } else if (command === "doctor") {
    options.command = "doctor";
  } else if (command === "version") {
    options.command = "version";
    return options;
  } else if (command === undefined) {
    options.command = "help";
    return options;
  } else {
    throw new UsageError(`Unknown command: ${command}`);
  }

  if (positionals.length > 0) {
    throw new UsageError(`Unexpected argument: ${positionals[0]}`);
  }
  if (options.command === "run" && options.project === undefined) {
    throw new UsageError("run requires --project <dir>.");
  }
  options.dataDir ??= defaultDataDir();
  if (options.project !== undefined && options.command !== "run") {
    throw new UsageError("--project is only valid with run.");
  }
  if (Object.keys(options.params).length > 0 && options.command !== "run") {
    throw new UsageError("--param is only valid with run.");
  }
  if (options.workspaceMode !== undefined && options.command !== "run") {
    throw new UsageError("--workspace is only valid with run.");
  }
  if (options.worktreePath !== undefined && options.command !== "run") {
    throw new UsageError("--worktree-path is only valid with run.");
  }
  if (options.workspaceMode === "existing-worktree" && options.worktreePath === undefined) {
    throw new UsageError("--workspace existing-worktree requires --worktree-path <dir>.");
  }
  if (options.workspaceMode !== "existing-worktree" && options.worktreePath !== undefined) {
    throw new UsageError("--worktree-path requires --workspace existing-worktree.");
  }
  if (options.retryUncertainShell && options.command !== "resume") {
    throw new UsageError("--retry-uncertain-shell is only valid with resume.");
  }
  if (
    (options.force !== undefined || options.timeoutSecs !== undefined) &&
    options.command !== "stop"
  ) {
    throw new UsageError("--force and --timeout are only valid with stop.");
  }
  if (options.probeDecisions && options.command !== "doctor") {
    throw new UsageError("--probe-decisions is only valid with doctor.");
  }
  if (
    options.fakeScript !== undefined &&
    options.command !== "run" &&
    options.command !== "resume" &&
    options.command !== "start"
  ) {
    throw new UsageError("--fake-script is only valid with start, run or resume.");
  }
  if (
    (options.port !== undefined ||
      options.noOpen ||
      options.printUrl ||
      options.headless ||
      options.detach ||
      options.secure) &&
    options.command !== "start"
  ) {
    throw new UsageError(
      "--port, --no-open, --print-url, --headless, --detach and --secure are only valid with start.",
    );
  }
  return options;
}

export const HELP = `devchestra — local DevChestra runner and browser API

Usage:
  devchestra start [--data-dir <dir>] [--port N] [--no-open] [--print-url] [--detach|-d] [options]
  devchestra run <workflow.json> --project <dir> [--data-dir <dir>] [options]
  devchestra resume <runId> [--data-dir <dir>] [--retry-uncertain-shell] [options]
  devchestra stop [--data-dir <dir>] [--force] [--timeout <secs>] [--json]
  devchestra status [--data-dir <dir>] [--json]
  devchestra doctor [--data-dir <dir>] [--json] [--probe-decisions]
  devchestra version
  devchestra skill [<name>|--all]
  devchestra capabilities --json
  devchestra project|workflow|run|approval|providers --help

Options:
  --port N                    Start only: 0 = ephemeral; on EADDRINUSE retries ephemeral
  --headless                  Start only: serve API without requiring web assets
  --detach, -d                Start only: run the server in the background (logs to <data-dir>/server.log)
  --secure                    Start only: require the session token (cookie or header) for browser and API access
  --no-open                   Start only: do not open the browser
  --print-url                 Start only: print the tokenised launch URL once
  --param k=v                 Run only: start parameter (repeatable; JSON parsed)
  --workspace MODE            Run only: project (default), new-worktree or existing-worktree
  --worktree-path <dir>       Run only: existing worktree of the project (with --workspace)
  --fake-script <file>        Test-only fake-agent JSON script (DEVCHESTRA_ALLOW_FAKE=1)
  --json                      NDJSON events plus a final summary
  --non-interactive           Never prompt
  --allow-experimental-adapters
                              Deprecated and ignored: all adapters are official
  --force                     Stop only: stop despite active runs; SIGKILL if it will not exit
  --timeout <secs>            Stop only: wait this long for a clean exit (default 15)
  --retry-uncertain-shell     Resume only: retry an uncertain shell effect
  --probe-decisions           Doctor only: send one tiny live request per ready
                              decision provider and print the redacted shape
  --data-dir <dir>            Default: $DEVCHESTRA_DATA_DIR, else ~/.local/share/devchestra
  --project <dir>             Run only: workflow must be inside it
`;

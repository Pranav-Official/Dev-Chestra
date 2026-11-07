import { execFile, type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DevChestraError } from "@devchestra/core";

const helper = fileURLToPath(new URL("../dist/native/windows-process.exe", import.meta.url));

export function windowsProcessIdentity(pid: number): { pidStart: string; binary: string } | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const result = spawnSync(helper, ["identity", String(pid)], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (result.status !== 0) return null;
  const [ticks, binary] = result.stdout.trim().split(/\r?\n/);
  return ticks !== undefined && /^\d+$/.test(ticks) && binary !== undefined
    ? { pidStart: `windows:${ticks}`, binary }
    : null;
}

export function protectWindowsDirectory(path: string): void {
  if (process.platform !== "win32") return;
  const result = spawnSync(helper, ["protect", path], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (result.status !== 0)
    throw new Error(
      `Cannot secure Windows data directory: ${result.stderr || result.error?.message}`,
    );
}

export function isWindowsPrivatePath(path: string): boolean {
  return spawnSync(helper, ["private", path], { windowsHide: true, timeout: 5000 }).status === 0;
}

export async function stopWindowsTree(pid: number, expectedStart?: string): Promise<boolean> {
  const identity =
    expectedStart === undefined ? windowsProcessIdentity(pid) : { pidStart: expectedStart };
  if (identity === null) return false;
  return new Promise((resolve) => {
    execFile(
      helper,
      ["stop", String(pid), identity.pidStart.slice(8)],
      { windowsHide: true, timeout: 10000 },
      (error) => resolve(error === null),
    );
  });
}

export function findWindowsExecutable(
  bin: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string | null {
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const names = extname(bin)
    ? [bin]
    : [`${bin}.exe`, `${bin}.com`, `${bin}.cmd`, `${bin}.bat`, bin];
  const roots =
    isAbsolute(bin) || /[\\/]/.test(bin) ? [cwd] : pathValue.split(delimiter).filter(Boolean);
  for (const root of roots)
    for (const name of names) {
      const candidate = resolve(cwd, root.replace(/^"|"$/g, ""), name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* next PATH entry */
      }
    }
  return null;
}

/** Resolve npm/Node shims to their entrypoint; never pass agent arguments to cmd.exe. */
export function windowsCommand(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): { bin: string; args: string[] } {
  const executable = findWindowsExecutable(bin, env, cwd);
  if (executable === null)
    throw new DevChestraError("E_CLI_MISSING", `CLI executable not found: ${bin}`);
  if (/\.(exe|com)$/i.test(executable)) return { bin: executable, args };
  if (/\.[cm]?js$/i.test(executable)) return { bin: process.execPath, args: [executable, ...args] };
  const text = readFileSync(executable, "utf8");
  if (/^#![^\r\n]*\bnode(?:\r?\n|$)/.test(text))
    return { bin: process.execPath, args: [executable, ...args] };
  if (!/\.(cmd|bat)$/i.test(executable))
    throw new Error(`Unsupported Windows executable: ${executable}`);
  const matches = [...text.matchAll(/"(?:%dp0%[\\/]|%~dp0)([^"\r\n]+\.(?:[cm]?js|exe))"/gi)];
  const match = matches.at(-1);
  if (match?.[1] === undefined)
    throw new Error(
      `Unsupported Windows command shim: ${executable}; use its .exe or Node entrypoint`,
    );
  const target = resolve(dirname(executable), match[1]);
  if (!existsSync(target))
    throw Object.assign(new Error(`CLI shim target is missing: ${target}`), { code: "ENOENT" });
  return /\.exe$/i.test(target)
    ? { bin: target, args }
    : { bin: process.execPath, args: [target, ...args] };
}

/** UTF-16 length including quotes, separators and terminating NUL. Matches
 * the native supervisor's CRT quoting; also bounds Node's helper argv. */
export function windowsCommandLineLength(bin: string, args: readonly string[]): number {
  let length = 0;
  for (const value of [bin, ...args]) {
    if (length > 0) length++;
    length += 2;
    let slashes = 0;
    for (const char of value) {
      if (char === "\\") {
        slashes++;
        continue;
      }
      length += char === '"' ? slashes * 2 + 2 : slashes + char.length;
      slashes = 0;
    }
    length += slashes * 2;
  }
  return length + 1;
}

export function assertWindowsCommandLine(bin: string, args: readonly string[]): void {
  const chars = windowsCommandLineLength(bin, args);
  if (chars > 32_767) {
    throw new DevChestraError(
      "E_VALIDATION",
      `Windows command line requires ${chars} UTF-16 characters (limit 32767); reduce CLI configuration arguments or pass large inputs through stdin or files`,
      { details: { step: "command_line_size", chars, maxChars: 32_767 } },
    );
  }
}

/** POSIX process groups on Unix; a suspended launch into a kill-on-close Job Object on Windows. */
export function spawnOwned(bin: string, args: string[], options: SpawnOptions) {
  if (process.platform !== "win32") return spawn(bin, args, { ...options, detached: true });
  const env = options.env ?? process.env;
  const command = windowsCommand(bin, args, env, String(options.cwd ?? process.cwd()));
  assertWindowsCommandLine(command.bin, command.args);
  const parent = windowsProcessIdentity(process.pid);
  if (parent === null) throw new Error("Cannot verify the Windows supervisor process");
  const helperArgs = [
    "run",
    String(process.pid),
    parent.pidStart.slice(8),
    command.bin,
    ...command.args,
  ];
  assertWindowsCommandLine(helper, helperArgs);
  return spawn(helper, helperArgs, {
    ...options,
    detached: false,
    windowsHide: true,
  });
}

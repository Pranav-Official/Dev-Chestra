import type { ContainerExecution, ContainerRuntime } from "./container-types.js";

export type { ContainerExecution, ContainerRuntime } from "./container-types.js";

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { DevChestraError } from "@devchestra/core";
import type { Invocation } from "./types.js";

export const DEFAULT_SANDBOX_IMAGE = "localhost/devchestra-sandbox:1";
export const CONTAINER_HOME = "/home/devchestra";
export const CONTAINER_PATH = "/usr/local/bin:/usr/bin:/bin";
function fail(message: string): never {
  throw new DevChestraError("E_WORKSPACE", message);
}
export function runtimeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [
    "PATH",
    "HOME",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "DBUS_SESSION_BUS_ADDRESS",
    "LANG",
    "TMPDIR",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name] as string;
  }
  return env;
}
export function containerRuntimeArgs(runtime: ContainerRuntime, args: string[]): string[] {
  return runtime.bin === "docker" ? ["--host", runtime.endpoint, ...args] : args;
}
export function runtimeCommand(runtime: string | ContainerRuntime, args: string[]): string {
  const bin = typeof runtime === "string" ? runtime : runtime.bin;
  const runtimeArgs = typeof runtime === "string" ? args : containerRuntimeArgs(runtime, args);
  const result = spawnSync(bin, runtimeArgs, {
    env: runtimeEnv(),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0)
    fail(
      `Container runtime ${bin} ${args[0]} failed: ${result.stderr?.trim() || result.error?.message || result.status}`,
    );
  return result.stdout.trim();
}
export function detectContainerRuntime(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  inspectImage = true,
): ContainerRuntime {
  if (process.platform !== "linux")
    fail("Container workspaces currently require Linux and a local runtime");
  const requested = env.DEVCHESTRA_CONTAINER_RUNTIME;
  if (requested !== undefined && requested !== "podman" && requested !== "docker")
    fail("DEVCHESTRA_CONTAINER_RUNTIME must be podman or docker");
  let bin: "podman" | "docker" | undefined;
  let info: {
    store?: { graphRoot?: string };
    host?: { serviceIsRemote?: boolean; security?: { selinuxEnabled?: boolean } };
    SecurityOptions?: string[];
  } = {};
  for (const candidate of requested ? ([requested] as const) : (["podman", "docker"] as const)) {
    try {
      info = JSON.parse(runtimeCommand(candidate, ["info", "--format", "json"]));
      bin = candidate;
      break;
    } catch (error) {
      if (requested) throw error;
    }
  }
  if (bin === undefined) fail("No usable local container runtime; install/start Podman or Docker");
  if (info.host?.serviceIsRemote === true) fail("Remote container runtimes are unsupported");
  // Docker CLI may be a Podman compatibility alias.
  if (info.host?.security && bin === "docker") bin = "podman";
  const endpoint =
    bin === "docker"
      ? runtimeCommand(bin, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
      : `local:${info.store?.graphRoot ?? ""}`;
  if (bin === "docker" && !endpoint.startsWith("unix:///"))
    fail("Docker container workspaces require a local Unix socket endpoint");
  if (bin === "podman" && endpoint === "local:")
    fail("Cannot establish local Podman storage identity");
  const image = env.DEVCHESTRA_CONTAINER_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
  const imageId = inspectImage
    ? runtimeCommand(bin, [
        ...(bin === "docker" ? ["--host", endpoint] : []),
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        image,
      ])
    : image;
  return {
    version: 1,
    endpoint,
    bin,
    image: inspectImage && /^[a-f0-9]{64}$/.test(imageId) ? `sha256:${imageId}` : imageId,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    selinux:
      info.host?.security?.selinuxEnabled === true ||
      (Array.isArray(info.SecurityOptions) &&
        info.SecurityOptions.some((s: string) => s.includes("selinux"))),
    owner: createHash("sha256").update(dataDir).digest("hex").slice(0, 20),
  };
}
export function prepareContainerRuntime(
  dataDir: string,
  runDir: string,
  requireExisting: boolean,
  env?: NodeJS.ProcessEnv,
): ContainerRuntime {
  const file = join(runDir, "container-runtime.json");
  if (existsSync(file)) {
    const runtime = JSON.parse(readFileSync(file, "utf8")) as ContainerRuntime;
    if (
      runtime.version !== 1 ||
      runtime.uid !== process.getuid?.() ||
      runtime.gid !== process.getgid?.() ||
      runtime.owner !== createHash("sha256").update(dataDir).digest("hex").slice(0, 20) ||
      !["podman", "docker"].includes(runtime.bin) ||
      typeof runtime.endpoint !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(runtime.image) ||
      !/^[a-f0-9]{20}$/.test(runtime.owner)
    )
      fail("Invalid persisted container runtime");
    const info = JSON.parse(runtimeCommand(runtime, ["info", "--format", "json"]));
    if (
      runtime.bin === "podman" &&
      (info.host?.serviceIsRemote || runtime.endpoint !== `local:${info.store?.graphRoot}`)
    )
      fail("Podman endpoint changed; refusing to resume");
    if (runtime.bin === "docker" && !runtime.endpoint.startsWith("unix:///"))
      fail("Invalid Docker endpoint");
    runtimeCommand(runtime, ["image", "inspect", runtime.image]);
    return runtime;
  }
  if (requireExisting)
    fail("Container runtime binding is missing; refusing to change runtime on resume");
  const runtime = detectContainerRuntime(dataDir, env);
  writeFileSync(file, JSON.stringify(runtime), { flag: "wx", mode: 0o600 });
  return runtime;
}
export function containerBaseEnv(
  source: Record<string, string>,
  cli?: string,
): Record<string, string> {
  const env = { ...source };
  for (const name of [
    "HOME",
    "PATH",
    "SHELL",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_CONFIG_DIR",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "PI_CODING_AGENT_DIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ])
    delete env[name];
  Object.assign(env, {
    HOME: CONTAINER_HOME,
    PATH: CONTAINER_PATH,
    SHELL: "/bin/sh",
    USER: "devchestra",
    XDG_CONFIG_HOME: `${CONTAINER_HOME}/.config`,
    XDG_DATA_HOME: `${CONTAINER_HOME}/.local/share`,
    XDG_CACHE_HOME: `${CONTAINER_HOME}/.cache`,
  });
  if (cli === "codex") env.CODEX_HOME = `${CONTAINER_HOME}/.codex`;
  if (cli === "claude-code") env.CLAUDE_CONFIG_DIR = `${CONTAINER_HOME}/.claude`;
  if (cli === "pi") env.PI_CODING_AGENT_DIR = `${CONTAINER_HOME}/.pi/agent`;
  return env;
}
export function credentialVolume(runtime: ContainerRuntime, cli: string): string {
  return `devchestra-${runtime.owner}-${cli}-home`;
}
export function ensureCredentialVolume(runtime: ContainerRuntime, cli: string): string {
  const name = credentialVolume(runtime, cli);
  const probe = spawnSync(runtime.bin, containerRuntimeArgs(runtime, ["volume", "inspect", name]), {
    env: runtimeEnv(),
    stdio: "ignore",
    timeout: 10_000,
  });
  if (probe.status !== 0) {
    runtimeCommand(runtime, [
      "volume",
      "create",
      "--label",
      `devchestra.owner=${runtime.owner}`,
      name,
    ]);
    runtimeCommand(runtime, [
      "run",
      "--rm",
      "--network=none",
      ...(runtime.bin === "podman" ? ["--userns=keep-id"] : []),
      "--user",
      "0:0",
      "--volume",
      `${name}:${CONTAINER_HOME}`,
      "--entrypoint",
      "/bin/chown",
      runtime.image,
      "-R",
      `${runtime.uid}:${runtime.gid}`,
      CONTAINER_HOME,
    ]);
  }
  return name;
}
export function containerArguments(
  spec: ContainerExecution,
  inv: Invocation,
  name: string,
  envFile?: string,
): string[] {
  const r = spec.runtime;
  const args = [
    "run",
    "--rm",
    "--init",
    "--interactive",
    "--name",
    name,
    "--label",
    `devchestra.owner=${r.owner}`,
    "--label",
    `devchestra.run=${spec.runId}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=512",
    "--memory=4g",
    "--cpus=4",
    "--log-driver=none",
    "--workdir",
    spec.cwd,
  ];
  if (r.bin === "podman") args.push("--userns=keep-id");
  args.push("--user", `${r.uid}:${r.gid}`);
  if (spec.network === false) args.push("--network=none");
  for (const mount of [
    { source: spec.cwd, target: spec.cwd, readOnly: spec.readOnlyWorkspace === true },
    ...(spec.mounts ?? []),
  ]) {
    if (mount.source.includes(":") || mount.target.includes(":"))
      fail("Container mount paths cannot contain ':'");
    args.push(
      "--volume",
      `${mount.source}:${mount.target}:${mount.readOnly ? "ro" : "rw"}${r.selinux ? ",z" : ""}`,
    );
  }
  if (spec.homeVolume) args.push("--volume", `${spec.homeVolume}:${CONTAINER_HOME}`);
  if (envFile) args.push("--env-file", envFile);
  for (const key of envFile ? [] : Object.keys(inv.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail("Invalid container environment variable name");
    args.push(
      "--env",
      [
        "HOME",
        "PATH",
        "SHELL",
        "USER",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
      ].includes(key)
        ? `${key}=${inv.env[key]}`
        : key,
    );
  }
  args.push("--entrypoint", inv.bin, r.image, ...inv.args);
  return containerRuntimeArgs(r, args);
}
export interface ContainerLaunch {
  invocation: Invocation;
  stop(): Promise<boolean>;
  cleanup(): void;
}
export function wrapContainerInvocation(
  inv: Invocation,
  spec: ContainerExecution,
): ContainerLaunch {
  const name = `devchestra-${createHash("sha256").update(`${spec.runId}/${spec.executionId}`).digest("hex").slice(0, 24)}-${randomUUID().slice(0, 8)}`;
  const registry = join(spec.dataDir, "sandbox", "containers");
  for (const source of [spec.cwd, ...(spec.mounts ?? []).map((mount) => mount.source)]) {
    const remainder = relative(source, registry);
    if (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`))
      fail("Container mounts must not expose the private runtime registry");
  }
  mkdirSync(registry, { recursive: true, mode: 0o700 });
  const file = join(registry, `${name}.json`);
  const envFile = join(registry, `${name}.env`);
  const lines = Object.entries(inv.env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n\0]/.test(value))
      fail("Container environment requires valid names and single-line values");
    return `${key}=${value}\n`;
  });
  const args = containerArguments(spec, inv, name, envFile);
  try {
    writeFileSync(file, JSON.stringify({ name, runtime: spec.runtime, runId: spec.runId }), {
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(envFile, lines.join(""), { flag: "wx", mode: 0o600 });
  } catch (error) {
    try {
      unlinkSync(envFile);
    } catch {}
    try {
      unlinkSync(file);
    } catch {}
    throw error;
  }
  const stop = async (): Promise<boolean> => stopContainer(spec.runtime, name);
  return {
    invocation: {
      ...inv,
      bin: spec.runtime.bin,
      args,
      env: runtimeEnv(),
      files: [],
    },
    stop,
    cleanup() {
      if (stopContainer(spec.runtime, name)) {
        try {
          unlinkSync(file);
          unlinkSync(envFile);
        } catch {}
      }
    },
  };
}
function stopContainer(runtime: ContainerRuntime, name: string): boolean {
  try {
    const info = JSON.parse(runtimeCommand(runtime, ["info", "--format", "json"]));
    if (
      runtime.bin === "podman" &&
      (info.host?.serviceIsRemote || runtime.endpoint !== `local:${info.store?.graphRoot}`)
    )
      return false;
    if (runtime.bin === "docker" && !runtime.endpoint.startsWith("unix:///")) return false;
  } catch {
    return false;
  }

  const result = spawnSync(
    runtime.bin,
    containerRuntimeArgs(runtime, [
      "inspect",
      "--format",
      '{{index .Config.Labels "devchestra.owner"}}',
      name,
    ]),
    { env: runtimeEnv(), encoding: "utf8", timeout: 10_000 },
  );
  if (result.status !== 0) {
    const alive = spawnSync(
      runtime.bin,
      containerRuntimeArgs(runtime, ["info", "--format", "json"]),
      {
        env: runtimeEnv(),
        stdio: "ignore",
        timeout: 10_000,
      },
    );
    return alive.status === 0 && /no such|not found|does not exist/i.test(result.stderr);
  }
  if (result.stdout.trim() !== runtime.owner) return false;
  return (
    spawnSync(runtime.bin, containerRuntimeArgs(runtime, ["rm", "--force", name]), {
      env: runtimeEnv(),
      stdio: "ignore",
      timeout: 15_000,
    }).status === 0
  );
}
export function recoverContainers(dataDir: string, runId?: string): void {
  const registry = join(dataDir, "sandbox", "containers");
  if (!existsSync(registry)) return;
  for (const entry of readdirSync(registry)) {
    if (!/^devchestra-[a-f0-9]{24}-[a-f0-9]{8}\.json$/.test(entry)) continue;
    const file = join(registry, entry);
    const record = JSON.parse(readFileSync(file, "utf8"));
    if (
      record.name !== basename(file, ".json") ||
      !["podman", "docker"].includes(record.runtime?.bin)
    )
      fail("Invalid container recovery record");
    if (runId !== undefined && record.runId !== runId) continue;
    if (!stopContainer(record.runtime, record.name))
      fail(`Unable to stop recorded container ${record.name}; recovery blocked`);
    unlinkSync(file);
    try {
      unlinkSync(join(registry, `${record.name}.env`));
    } catch {}
  }
}

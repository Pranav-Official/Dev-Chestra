import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { McpScope } from "@devchestra/schema";
import type { InternalMcpServer } from "./types.js";

const SUMMARY_MAX = 120;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Truncate and drop control characters; never throws. */
export function cleanText(value: string, max: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
  const flat = value.replace(/[\u0000-\u001f\u007f]/gu, "");
  return flat.length <= max ? flat : flat.slice(0, max);
}

export function isValidName(name: string): boolean {
  return name !== "" && name.length <= 128 && !hasControlChars(name) && name !== "devchestra";
}

/** Read a file as UTF-8. Returns null when missing; throws on malformed read errors. */
export function tryReadFile(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
  } catch {
    return null;
  }
  return readFileSync(path, "utf8");
}

/**
 * Strip `//` line and `/*` block comments outside strings so JSONC config
 * files parse with `JSON.parse`. Best-effort: a `#` comment style is not
 * stripped. Never throws.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;
  while (i < text.length) {
    const char = text[i];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      i += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      i += 1;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/** Parse JSON (with comments tolerated). Returns the value or throws. */
export function parseJsonFile(text: string): unknown {
  return JSON.parse(stripJsonComments(text)) as unknown;
}

function tomlError(message: string): Error {
  return new Error(`invalid TOML: ${message}`);
}

function parseTomlString(text: string, start: number): { value: string; end: number } {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") throw tomlError("expected string");
  let i = start + 1;
  let out = "";
  const multiline = text.startsWith(quote + quote + quote, start);
  if (multiline) {
    i = start + 3;
    if (text[i] === "\n") i += 1;
    while (i < text.length) {
      if (text.startsWith(quote + quote + quote, i)) return { value: out, end: i + 3 };
      if (text[i] === "\\") throw tomlError("escapes unsupported in literal strings");
      out += text[i];
      i += 1;
    }
    throw tomlError("unterminated string");
  }
  while (i < text.length) {
    const char = text[i];
    if (char === "\\") {
      const next = text[i + 1];
      const escapes: Record<string, string> = {
        n: "\n",
        t: "\t",
        r: "\r",
        '"': '"',
        "\\": "\\",
      };
      if (next !== undefined && next in escapes) {
        out += escapes[next];
        i += 2;
        continue;
      }
      throw tomlError("unsupported escape");
    }
    if (char === quote) return { value: out, end: i + 1 };
    if (char === "\n") throw tomlError("unterminated string");
    out += char;
    i += 1;
  }
  throw tomlError("unterminated string");
}

function splitTomlArray(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString !== null) {
      current += char;
      if (char === "\\") {
        current += text[i + 1] ?? "";
        i += 1;
      } else if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      current += char;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    if (char === "]" || char === "}") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

function parseTomlValue(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const { value, end } = parseTomlString(trimmed, 0);
    if (trimmed.slice(end).trim() !== "") throw tomlError("trailing characters");
    return value;
  }
  if (trimmed.startsWith("[")) {
    if (!trimmed.endsWith("]")) throw tomlError("unterminated array");
    const items = splitTomlArray(trimmed.slice(1, -1));
    return items.map((item) => parseTomlValue(item));
  }
  if (trimmed.startsWith("{")) {
    if (!trimmed.endsWith("}")) throw tomlError("unterminated inline table");
    const table: Record<string, unknown> = {};
    for (const part of splitTomlArray(trimmed.slice(1, -1))) {
      const eq = part.indexOf("=");
      if (eq === -1) throw tomlError("inline table entry without =");
      table[part.slice(0, eq).trim()] = parseTomlValue(part.slice(eq + 1));
    }
    return table;
  }
  if (/^[+-]?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^[+-]?(\d+\.\d*|\d*\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return Number.parseFloat(trimmed);
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed;
  throw tomlError(`unsupported value: ${trimmed.slice(0, 24)}`);
}

function parseTomlKey(text: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (text[i] === " " || text[i] === "\t") i += 1;
    if (text[i] === '"' || text[i] === "'") {
      const { value, end } = parseTomlString(text, i);
      parts.push(value);
      i = end;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (match === null) throw tomlError(`bad key: ${text.slice(0, 24)}`);
      parts.push(match[0]);
      i += match[0].length;
    }
    while (text[i] === " " || text[i] === "\t") i += 1;
    if (i >= text.length) break;
    if (text[i] !== ".") throw tomlError(`bad key: ${text.slice(0, 24)}`);
    i += 1;
  }
  return parts;
}

function setTomlPath(root: Record<string, unknown>, path: string[], value: unknown): void {
  let node = root;
  for (const part of path.slice(0, -1)) {
    const next = node[part];
    if (next === undefined) {
      const fresh: Record<string, unknown> = {};
      node[part] = fresh;
      node = fresh;
    } else if (isRecord(next)) {
      node = next;
    } else {
      throw tomlError("conflicting table");
    }
  }
  const last = path[path.length - 1];
  if (last === undefined) throw tomlError("empty key");
  if (node[last] !== undefined) throw tomlError("duplicate key");
  node[last] = value;
}

/**
 * Minimal TOML parser for CLI config files: dotted table headers, string /
 * bool / int / float / array / inline-table values, `#` comments. Anything
 * fancier throws and the caller marks the file invalid.
 */
export function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let table: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = stripTomlComment(rawLine).trim();
    if (line === "") continue;
    if (line.startsWith("[")) {
      if (!line.endsWith("]")) throw tomlError("unterminated table header");
      const header = line
        .slice(1, -1)
        .trim()
        .replace(/^\[+|\]+$/g, "")
        .trim();
      table = parseTomlKey(header);
      setTomlPath(root, table, {});
      const node = getTomlPath(root, table);
      if (!isRecord(node)) throw tomlError("conflicting table");
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) throw tomlError("line without =");
    const key = parseTomlKey(line.slice(0, eq).trim());
    const value = parseTomlValue(line.slice(eq + 1));
    setTomlPath(root, [...table, ...key], value);
  }
  return root;
}

function stripTomlComment(line: string): string {
  let inString: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inString !== null) {
      if (char === "\\") i += 1;
      else if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }
    if (char === "#") return line.slice(0, i);
  }
  return line;
}

function getTomlPath(root: Record<string, unknown>, path: string[]): unknown {
  let node: unknown = root;
  for (const part of path) {
    if (!isRecord(node)) return undefined;
    node = node[part];
  }
  return node;
}

/** `npx @x/y` from command + first arg; falls back to the bare command name. */
export function summarizeStdio(command: string, args: readonly string[]): string {
  const base = basename(command);
  const first = args[0];
  const summary = first === undefined || first === "" ? base : `${base} ${first}`;
  return cleanText(summary, SUMMARY_MAX);
}

/** Host of a URL, or "remote" when it does not parse. Never credentials, path or query. */
export function summarizeUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    if (host !== "") return cleanText(host, SUMMARY_MAX);
  } catch {
    // Fall through to the generic label.
  }
  return "remote";
}

export function tildeify(path: string, home: string): string {
  if (home !== "" && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

export function resolveHome(home: string | undefined, env: NodeJS.ProcessEnv): string {
  if (home !== undefined && home !== "") return home;
  const fromEnv = env.HOME;
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  if (process.platform === "win32") return env.USERPROFILE ?? "";
  return "";
}

/** Absolute project dir; falls back to the raw value when it cannot resolve. */
export function absProjectDir(projectDir: string): string {
  try {
    const resolved = isAbsolute(projectDir) ? projectDir : resolve(projectDir);
    return resolved;
  } catch {
    return projectDir;
  }
}

function stringMap(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return null;
    out[key] = entry;
  }
  return out;
}

export interface GenericServerEntry {
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * Parse one tolerant MCP server entry shared by the JSON config shapes
 * (Claude `.mcp.json` / `.claude.json`, Pi `mcp.json`). Accepts stdio
 * (`command` + `args`, `env`) and remote (`url`, `headers`, optional `type`).
 * Returns null when the entry is not a usable server.
 */
export function parseGenericServerEntry(entry: unknown): GenericServerEntry | null {
  if (!isRecord(entry)) return null;
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
  if (type === "sse") {
    if (typeof entry.url !== "string" || entry.url === "") return null;
    const headers = entry.headers === undefined ? {} : stringMap(entry.headers);
    if (headers === null) return null;
    return { transport: "sse", url: entry.url, headers };
  }
  if (type === "http" || type === "remote" || typeof entry.url === "string") {
    if (typeof entry.url !== "string" || entry.url === "") return null;
    const headers = entry.headers === undefined ? {} : stringMap(entry.headers);
    if (headers === null) return null;
    return { transport: type === "sse" ? "sse" : "http", url: entry.url, headers };
  }
  if (typeof entry.command === "string" && entry.command !== "") {
    const args =
      entry.args === undefined
        ? []
        : Array.isArray(entry.args) && entry.args.every((a) => typeof a === "string")
          ? (entry.args as string[])
          : null;
    if (args === null) return null;
    const env = entry.env === undefined ? {} : stringMap(entry.env);
    if (env === null) return null;
    const result: GenericServerEntry = { transport: "stdio", command: entry.command, args, env };
    if (typeof entry.cwd === "string" && entry.cwd !== "") result.cwd = entry.cwd;
    return result;
  }
  return null;
}

export function toInternal(
  name: string,
  scope: McpScope,
  source: string,
  parsed: GenericServerEntry,
  status: InternalMcpServer["status"],
): InternalMcpServer {
  const hasSecrets =
    (parsed.env !== undefined && Object.keys(parsed.env).length > 0) ||
    (parsed.headers !== undefined && Object.keys(parsed.headers).length > 0);
  const summary =
    parsed.transport === "stdio" && parsed.command !== undefined
      ? summarizeStdio(parsed.command, parsed.args ?? [])
      : parsed.url !== undefined
        ? summarizeUrl(parsed.url)
        : parsed.transport;
  return {
    id: `${scope}:${name}`,
    name,
    scope,
    transport: parsed.transport,
    summary,
    source,
    status,
    hasSecrets,
    ...(parsed.command === undefined ? {} : { command: parsed.command }),
    ...(parsed.args === undefined ? {} : { args: parsed.args }),
    ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
    ...(parsed.env === undefined ? {} : { env: parsed.env }),
    ...(parsed.url === undefined ? {} : { url: parsed.url }),
    ...(parsed.headers === undefined ? {} : { headers: parsed.headers }),
  };
}

export function invalidServer(
  name: string,
  scope: McpScope,
  source: string,
  summary = "unparseable server entry",
): InternalMcpServer {
  return {
    id: `${scope}:${name}`,
    name,
    scope,
    transport: "stdio",
    summary,
    source,
    status: "invalid",
    hasSecrets: false,
  };
}

export function exists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

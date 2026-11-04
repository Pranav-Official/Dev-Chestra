import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fsSlug, type Path, parsePath } from "@devchestra/core";
import type { TranscriptLine, TranscriptPage } from "./ports.js";

const MAX_LINES = 200;
const MAX_PAGE_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024;
const KINDS = new Set(["text", "tool", "tool_result", "stderr", "notice", "raw", "system"]);

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

export function transcriptPath(input: {
  dataDir: string;
  projectId: string;
  runId: string;
  path: string;
  attempt: number;
  generation: number;
}): string | null {
  if (!safeName(input.projectId) || !safeName(input.runId)) return null;
  const parsed = parsePath(input.path);
  if (!parsed.ok) return null;
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) return null;
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) return null;
  const name = `${fsSlug(input.path as Path)}.a${input.attempt}.g${input.generation}.jsonl`;
  const root = realpathSync.native(input.dataDir);
  const candidate = resolve(
    join(root, "projects", input.projectId, "runs", input.runId, "transcripts", name),
  );
  if (!within(root, candidate)) return null;
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(candidate);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  const real = realpathSync.native(candidate);
  return within(root, real) ? real : null;
}

function parseLine(raw: string): TranscriptLine | null {
  if (raw.trim() === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string") return null;
  const kind =
    typeof record.kind === "string" && KINDS.has(record.kind)
      ? (record.kind as TranscriptLine["kind"])
      : "raw";
  return {
    ts: typeof record.ts === "string" ? record.ts : null,
    kind,
    text: record.text,
  };
}

/** Decodes one raw JSONL line, clipping oversized text; null for blank or unparseable lines. */
function decodeLine(raw: string): TranscriptLine | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_LINE_BYTES) {
    return {
      ts: null,
      kind: "notice",
      text: `[transcript line omitted: ${Buffer.byteLength(raw, "utf8")} bytes]`,
    };
  }
  const line = parseLine(raw);
  if (line === null) return null;
  const textBytes = Buffer.byteLength(line.text, "utf8");
  if (textBytes <= MAX_TEXT_BYTES) return line;
  const clipped = Buffer.from(line.text, "utf8").subarray(0, MAX_TEXT_BYTES).toString("utf8");
  return { ts: line.ts, kind: line.kind, text: `${clipped}\n[truncated: ${textBytes} bytes]` };
}

export function unavailableTranscript(
  attempt: number | null,
  generation: number | null,
  state: "pending" | "unavailable" = "unavailable",
): TranscriptPage {
  return {
    state,
    lines: [],
    nextCursor: null,
    hasMore: false,
    attempt,
    generation,
    bytes: null,
    endCursor: null,
    updatedAt: null,
  };
}

export async function readTranscriptPage(input: {
  dataDir: string;
  projectId: string;
  runId: string;
  path: string;
  attempt: number;
  generation: number;
  cursor: number;
  limit: number;
  byteCursor?: boolean;
}): Promise<TranscriptPage> {
  if (input.byteCursor) return readBytePage(input);
  const file = transcriptPath(input);
  if (file === null) return unavailableTranscript(input.attempt, input.generation);
  const limit = Math.min(Math.max(input.limit, 1), MAX_LINES);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return unavailableTranscript(input.attempt, input.generation);
  }
  let size = 0;
  let updatedAt: string | null = null;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      closeSync(fd);
      return unavailableTranscript(input.attempt, input.generation);
    }
    size = stat.size;
    updatedAt = stat.mtime.toISOString();
  } catch {
    closeSync(fd);
    return unavailableTranscript(input.attempt, input.generation);
  }

  const stream = createReadStream(file, { fd, autoClose: true, encoding: "utf8" });
  const lines: TranscriptLine[] = [];
  let buffer = "";
  let lineNumber = 0;
  let bytes = 0;
  let full = false;
  let discarding = false;
  let discardedBytes = 0;

  const push = (line: TranscriptLine): boolean => {
    const cost = Buffer.byteLength(line.text, "utf8") + 64;
    if (bytes + cost > MAX_PAGE_BYTES && lines.length > 0) {
      full = true;
      return false;
    }
    lines.push(line);
    bytes += cost;
    return true;
  };

  const notice = (count: number): TranscriptLine => ({
    ts: null,
    kind: "notice",
    text: `[transcript line omitted: ${count} bytes]`,
  });

  const consume = (raw: string): void => {
    if (lineNumber >= input.cursor) {
      const line = decodeLine(raw);
      if (line !== null && !push(line)) {
        full = true;
        return;
      }
    }
    lineNumber += 1;
  };

  try {
    for await (const chunk of stream) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (discarding) {
          const count = discardedBytes + Buffer.byteLength(raw, "utf8");
          const accepted = lineNumber < input.cursor || push(notice(count));
          if (!accepted) {
            full = true;
            break;
          }
          lineNumber += 1;
          discarding = false;
          discardedBytes = 0;
        } else {
          consume(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
        }
        if (full || lines.length >= limit) {
          full = true;
          break;
        }
        newline = buffer.indexOf("\n");
      }
      if (full) break;
      if (!discarding && Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
        discarding = true;
        discardedBytes += Buffer.byteLength(buffer, "utf8");
        buffer = "";
      } else if (discarding) {
        discardedBytes += Buffer.byteLength(buffer, "utf8");
        buffer = "";
      }
    }
    if (!full && buffer !== "" && !discarding) {
      // An unterminated tail may be a record still being written; count it only once it parses.
      const tail = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (parseLine(tail) !== null) consume(tail);
    }
  } finally {
    stream.destroy();
  }
  return {
    state: "available",
    lines,
    nextCursor: full ? String(lineNumber) : null,
    hasMore: full,
    attempt: input.attempt,
    generation: input.generation,
    bytes: size,
    endCursor: String(lineNumber),
    updatedAt,
  };
}

/**
 * The most recent `tail` records of a transcript, for watching a node that is
 * still running. `endCursor` points past the last complete line, so the caller
 * can continue with `cursor=<endCursor>` and receive only new lines.
 */
export async function readTranscriptTail(input: {
  dataDir: string;
  projectId: string;
  runId: string;
  path: string;
  attempt: number;
  generation: number;
  tail: number;
}): Promise<TranscriptPage> {
  const file = transcriptPath(input);
  if (file === null) return unavailableTranscript(input.attempt, input.generation);
  const keep = Math.min(Math.max(input.tail, 1), MAX_LINES);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return unavailableTranscript(input.attempt, input.generation);
  }
  let size: number;
  let updatedAt: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      closeSync(fd);
      return unavailableTranscript(input.attempt, input.generation);
    }
    size = stat.size;
    updatedAt = stat.mtime.toISOString();
  } catch {
    closeSync(fd);
    return unavailableTranscript(input.attempt, input.generation);
  }

  // Search backwards for recent records, with a fixed cap even for enormous lines.
  const cap = Math.min(size, 2 * MAX_LINE_BYTES);
  const data = Buffer.alloc(cap);
  const start = size - cap;
  try {
    let read = 0;
    while (read < cap) {
      const n = readSync(fd, data, read, cap - read, start + read);
      if (n === 0) break;
      read += n;
    }
    const actual = data.subarray(0, read);
    const lastNewline = actual.lastIndexOf(10);
    const end = lastNewline < 0 ? 0 : start + lastNewline + 1;
    let begin = lastNewline;
    let count = 0;
    while (begin > 0 && count < keep) {
      begin -= 1;
      if (actual[begin] === 10) count += 1;
    }
    if (count === keep) begin += 1;
    else if (start > 0) {
      const boundary = actual.indexOf(10);
      begin = boundary < 0 || boundary >= lastNewline ? lastNewline + 1 : boundary + 1;
    } else begin = 0;
    const lines =
      lastNewline < 0
        ? []
        : actual
            .subarray(begin, lastNewline + 1)
            .toString("utf8")
            .split("\n")
            .slice(0, -1)
            .map((raw) => decodeLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw))
            .filter((line): line is TranscriptLine => line !== null)
            .slice(-keep);
    if (start > 0 && count < keep && lastNewline >= 0) {
      lines.unshift({ ts: null, kind: "notice", text: "[earlier transcript record omitted]" });
      if (lines.length > keep) lines.shift();
    }
    const cursor = `b${end}`;
    return {
      state: "available",
      lines,
      nextCursor: cursor,
      hasMore: false,
      attempt: input.attempt,
      generation: input.generation,
      bytes: size,
      endCursor: cursor,
      updatedAt,
    };
  } finally {
    closeSync(fd);
  }
}

/** Continue a monitoring cursor without rescanning historical records. */
async function readBytePage(input: {
  dataDir: string;
  projectId: string;
  runId: string;
  path: string;
  attempt: number;
  generation: number;
  cursor: number;
  limit: number;
}): Promise<TranscriptPage> {
  const file = transcriptPath(input);
  if (file === null) return unavailableTranscript(input.attempt, input.generation);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return unavailableTranscript(input.attempt, input.generation);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return unavailableTranscript(input.attempt, input.generation);
    let position = Math.min(input.cursor, stat.size);
    let committed = position;
    let parts: Buffer[] = [];
    let length = 0;
    const lines: TranscriptLine[] = [];
    let cost = 0;
    let full = false;
    const chunk = Buffer.alloc(64 * 1024);
    while (position < stat.size && !full) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - position), position);
      if (n === 0) break;
      let from = 0;
      for (let i = 0; i < n; i += 1) {
        if (chunk[i] !== 10) continue;
        const part = chunk.subarray(from, i);
        length += part.length;
        if (length <= MAX_LINE_BYTES) parts.push(Buffer.from(part));
        const line =
          length > MAX_LINE_BYTES
            ? {
                ts: null,
                kind: "notice" as const,
                text: `[transcript line omitted: ${length} bytes]`,
              }
            : decodeLine(Buffer.concat(parts).toString("utf8").replace(/\r$/u, ""));
        const lineCost = line === null ? 0 : Buffer.byteLength(line.text, "utf8") + 64;
        if (line !== null && lines.length > 0 && cost + lineCost > MAX_PAGE_BYTES) {
          full = true;
          break;
        }
        if (line !== null) {
          lines.push(line);
          cost += lineCost;
        }
        committed = position + i + 1;
        parts = [];
        length = 0;
        from = i + 1;
        if (lines.length >= Math.min(input.limit, MAX_LINES)) {
          full = true;
          break;
        }
      }
      if (!full) {
        const part = chunk.subarray(from, n);
        length += part.length;
        if (length <= MAX_LINE_BYTES) parts.push(Buffer.from(part));
        position += n;
      }
    }
    const cursor = `b${committed}`;
    return {
      state: "available",
      lines,
      nextCursor: full ? cursor : null,
      hasMore: full,
      attempt: input.attempt,
      generation: input.generation,
      bytes: stat.size,
      endCursor: cursor,
      updatedAt: stat.mtime.toISOString(),
    };
  } finally {
    closeSync(fd);
  }
}

export function parseTranscriptCursor(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  if (!/^\d{1,15}$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("Invalid transcript cursor");
  }
  return Number(value);
}

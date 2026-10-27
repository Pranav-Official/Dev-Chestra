import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fsSlug, type Path, parsePath } from "@relay/core";
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
}): Promise<TranscriptPage> {
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
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      closeSync(fd);
      return unavailableTranscript(input.attempt, input.generation);
    }
    size = stat.size;
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
      let line: TranscriptLine | null;
      if (Buffer.byteLength(raw, "utf8") > MAX_LINE_BYTES) {
        line = notice(Buffer.byteLength(raw, "utf8"));
      } else {
        line = parseLine(raw);
        if (line !== null) {
          const textBytes = Buffer.byteLength(line.text, "utf8");
          if (textBytes > MAX_TEXT_BYTES) {
            const clipped = Buffer.from(line.text, "utf8")
              .subarray(0, MAX_TEXT_BYTES)
              .toString("utf8");
            line = {
              ts: line.ts,
              kind: line.kind,
              text: `${clipped}\n[truncated: ${textBytes} bytes]`,
            };
          }
        }
      }
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
      consume(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    } else if (!full && discarding) {
      if (lineNumber >= input.cursor) push(notice(discardedBytes));
      lineNumber += 1;
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
  };
}

export function parseTranscriptCursor(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  if (!/^\d{1,9}$/u.test(value)) {
    throw new Error("Invalid transcript cursor");
  }
  return Number(value);
}

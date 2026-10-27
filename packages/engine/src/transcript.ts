import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { TranscriptEntry } from "@relay/adapters";
import { fsSlug, type Path, RelayError } from "@relay/core";
import { redactJson } from "@relay/store";
import { resolveInside } from "@relay/workspaces";

export interface TranscriptWriter {
  write(entry: TranscriptEntry): void;
  close(): void;
  readonly file: string;
  bytes(): number;
}

export function openTranscript(input: {
  dataDir: string;
  projectId: string;
  runId: string;
  path: Path;
  attempt: number;
  generation: number;
  secrets: readonly string[];
}): TranscriptWriter {
  const root = realpathSync.native(input.dataDir);
  const name = `${fsSlug(input.path)}.a${input.attempt}.g${input.generation}.jsonl`;
  const relative = join("projects", input.projectId, "runs", input.runId, "transcripts", name);
  const resolved = resolveInside(root, relative);
  if (!resolved.ok) throw resolved.error;
  const file = resolved.value;
  mkdirSync(join(root, "projects", input.projectId, "runs", input.runId, "transcripts"), {
    recursive: true,
    mode: 0o700,
  });
  const fd = openSync(
    file,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  const stat = fstatSync(fd);
  if (!stat.isFile()) {
    closeSync(fd);
    throw new RelayError("E_WORKSPACE", "Transcript path is not a regular file");
  }
  let closed = false;
  let total = stat.size;

  const redact = (text: string): string => {
    let value = redactJson(text) as string;
    for (const secret of [...input.secrets].sort((left, right) => right.length - left.length)) {
      if (secret !== "") value = value.split(secret).join("[redacted]");
    }
    return value;
  };

  return {
    file,
    bytes: () => total,
    close(): void {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
    write(entry: TranscriptEntry): void {
      if (closed) throw new RelayError("E_INTERNAL", "Transcript writer is closed");
      const payload = `${JSON.stringify({
        ts: entry.ts,
        kind: entry.kind,
        text: redact(entry.text),
      })}\n`;
      writeSync(fd, payload, null, "utf8");
      total = fstatSync(fd).size;
    },
  };
}

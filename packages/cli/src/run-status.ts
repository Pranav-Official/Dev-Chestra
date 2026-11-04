import {
  type ApiClient,
  type CompactActivity,
  type CompactRunStatus,
  compactRunStatus,
  type RunDetailResponse,
} from "@devchestra/api";

/** Most running agent nodes whose transcripts are sampled for liveness per status call. */
const MAX_ACTIVITY_NODES = 3;
/** Recent transcript lines scanned for the last tool call. */
const TOOL_SCAN_LINES = 8;
const MAX_TOOL_CHARS = 80;

type TranscriptSource = Pick<ApiClient, "getExecutionTranscript">;

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > MAX_TOOL_CHARS ? `${line.slice(0, MAX_TOOL_CHARS - 1)}…` : line;
}

/**
 * Liveness of the running agent nodes: when the transcript was last written,
 * how long ago that is, and the most recent tool call. A node with no
 * transcript yet is measured from when it started. A failed lookup just omits
 * that node, so monitoring never fails because a transcript could not be read.
 */
export async function nodeActivity(
  client: TranscriptSource,
  detail: RunDetailResponse,
  now: number,
  signal?: AbortSignal,
): Promise<Record<string, CompactActivity>> {
  const running = Object.values(detail.view.executions)
    .filter(
      (exec) =>
        exec.kind === "agent" && (exec.status === "running" || exec.status === "validating"),
    )
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    .slice(0, MAX_ACTIVITY_NODES);
  const entries = await Promise.all(
    running.map(async (exec): Promise<[string, CompactActivity] | null> => {
      try {
        const page = await client.getExecutionTranscript(
          detail.run.id,
          exec.path,
          { tail: TOOL_SCAN_LINES },
          signal === undefined ? {} : { signal },
        );
        const touched = page.updatedAt === null ? null : Date.parse(page.updatedAt);
        const since = touched ?? exec.startedAt;
        const tool = page.lines.findLast((line) => line.kind === "tool");
        return [
          exec.path,
          {
            updatedAt: page.updatedAt,
            idleSec: since === null ? null : Math.max(0, Math.round((now - since) / 1000)),
            lastTool: tool === undefined ? null : firstLine(tool.text),
          },
        ];
      } catch {
        return null;
      }
    }),
  );
  return Object.fromEntries(entries.filter((entry) => entry !== null));
}

/** Fetches a run and projects its compact status, including liveness of running agents. */
export async function fetchRunStatus(
  client: Pick<ApiClient, "getRun" | "getExecutionTranscript">,
  runId: string,
  signal?: AbortSignal,
): Promise<{ detail: RunDetailResponse; status: CompactRunStatus }> {
  const detail = await client.getRun(runId, signal === undefined ? {} : { signal });
  const now = Date.now();
  const activity = await nodeActivity(client, detail, now, signal);
  return { detail, status: compactRunStatus(detail, { now, activity }) };
}

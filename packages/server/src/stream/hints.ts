import type { EventEnvelope } from "@relay/core";
import type { GlobalStreamHint, StreamStorePort } from "./types.js";

function isRunLifecycle(type: string): boolean {
  switch (type) {
    case "run.created":
    case "run.started":
    case "run.paused":
    case "run.resumed":
    case "run.cancelled":
    case "run.completed":
      return true;
    default:
      return false;
  }
}

/** Global stream carries invalidation hints only, never EventEnvelope data. */
export function globalHints(event: EventEnvelope, store: StreamStorePort): GlobalStreamHint[] {
  const hints: GlobalStreamHint[] = [];

  if (isRunLifecycle(event.type)) {
    const run = store.runHeader(event.runId);
    if (run !== null) {
      hints.push({
        event: "run.status",
        data: {
          runId: event.runId,
          projectId: run.project.id,
          workflowId: run.workflowId,
          status: run.status,
          runNumber: run.runNumber,
        },
      });
    }
  }

  switch (event.type) {
    case "approval.requested":
      hints.push({ event: "inbox", data: { changed: true } });
      hints.push({
        event: "notification",
        data: { level: "info", message: "Approval requested", runId: event.runId },
      });
      break;
    case "approval.resolved":
    case "checkpoint.opened":
    case "checkpoint.closed":
    case "supervisor.woke":
      hints.push({ event: "inbox", data: { changed: true } });
      break;
    case "quota.blocked": {
      const payload = event.payload as { provider?: string; kind?: string; resumeAt?: number };
      const name = payload.provider ?? "unknown";
      hints.push({
        event: "provider",
        data: {
          name,
          status: "blocked",
          ...(payload.resumeAt === undefined ? {} : { resumeAt: payload.resumeAt }),
          ...(payload.kind === undefined ? {} : { reason: payload.kind }),
        },
      });
      hints.push({
        event: "notification",
        data: { level: "warning", message: `Provider ${name} blocked`, runId: event.runId },
      });
      break;
    }
    case "quota.released": {
      const payload = event.payload as { provider?: string; by?: string };
      hints.push({
        event: "provider",
        data: {
          name: payload.provider ?? "unknown",
          status: "released",
          ...(payload.by === undefined ? {} : { reason: payload.by }),
        },
      });
      break;
    }
    default:
      break;
  }
  return hints;
}

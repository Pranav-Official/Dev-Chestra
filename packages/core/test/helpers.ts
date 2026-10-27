import {
  type Actor,
  type EventEnvelope,
  type EventPayloads,
  formatPath,
  type KnownEventType,
  type NodeId,
  type Path,
  type RunId,
} from "../src/index.js";

export const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId;
export const RUN_PATH = "" as Path;
export const AGENT_PATH = formatPath([{ node: "agent" as NodeId }]);
const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);

let nextId = 0;

export function resetEventIds(): void {
  nextId = 0;
}

export interface EventOptions {
  id?: number;
  runId?: RunId;
  ts?: string;
  path?: Path;
  actor?: Actor;
  v?: number;
}

export function ev<K extends KnownEventType>(
  type: K,
  payload: EventPayloads[K],
  options: EventOptions = {},
): EventEnvelope<K> {
  if (options.id === undefined) nextId += 1;
  const id = options.id ?? nextId;
  return {
    id,
    runId: options.runId ?? RUN_ID,
    ts: options.ts ?? new Date(BASE_TIME + id * 1000).toISOString(),
    path: options.path ?? AGENT_PATH,
    type,
    actor: options.actor ?? "engine",
    v: options.v ?? 1,
    payload,
  } as EventEnvelope<K>;
}

export function nodePath(node: string, index?: number, round?: number): Path {
  return formatPath([
    index === undefined && round === undefined
      ? { node: node as NodeId }
      : index !== undefined
        ? { node: node as NodeId, index }
        : { node: node as NodeId, round: round as number },
  ]);
}

import assert from "node:assert/strict";
import { type EventEnvelope, project, type RunView } from "@relay/core";

export interface ViewSummary {
  status: string;
  lastEventId: number;
  executions: Record<
    string,
    {
      status: string;
      attempt: number;
      generation: number;
      acceptedEventId: number | null;
      recordedEventId: number | null;
      errorCode: string | null;
    }
  >;
  edges: Record<string, string>;
  budget: unknown;
}

export function summarize(view: RunView): ViewSummary {
  const executions: ViewSummary["executions"] = {};
  for (const path of Object.keys(view.executions).sort()) {
    const execution = view.executions[path];
    if (execution === undefined) continue;
    executions[path] = {
      status: execution.status,
      attempt: execution.attempt,
      generation: execution.generation,
      acceptedEventId: execution.acceptedResult?.acceptedEventId ?? null,
      recordedEventId: execution.recordedOutput?.eventId ?? null,
      errorCode: execution.lastError?.code ?? null,
    };
  }
  return {
    status: view.status,
    lastEventId: view.lastEventId,
    executions,
    edges: view.edges,
    budget: view.budget,
  };
}

export function projectEvents(events: readonly EventEnvelope[]): RunView {
  return project(events as Iterable<EventEnvelope>);
}

export function assertViewEqual(actual: RunView, expected: RunView, label: string): void {
  assert.deepStrictEqual(
    summarize(actual),
    summarize(expected),
    `${label}: projection mismatch (actual vs expected)`,
  );
}

export function assertProjectionMatches(
  events: readonly EventEnvelope[],
  view: RunView,
  label: string,
): void {
  assertViewEqual(projectEvents(events), view, label);
}

export function assertStrictlyIncreasingIds(
  ids: readonly number[],
  label: string,
  allowGaps: boolean,
): void {
  assert.ok(ids.length > 0, `${label}: no event ids`);
  const seen = new Set<number>();
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    if (id === undefined) throw new Error(`${label}: missing id at ${String(index)}`);
    assert.ok(!seen.has(id), `${label}: duplicate event id ${String(id)}`);
    seen.add(id);
    const previous = ids[index - 1];
    if (previous !== undefined) {
      if (allowGaps) {
        assert.ok(
          id > previous,
          `${label}: id ${String(id)} did not increase after ${String(previous)}`,
        );
      } else {
        assert.equal(id, previous + 1, `${label}: missing id after ${String(previous)}`);
      }
    }
  }
}

export function assertSameIds(
  actual: readonly number[],
  expected: readonly number[],
  label: string,
): void {
  assert.deepStrictEqual(
    [...actual].sort((a, b) => a - b),
    [...expected].sort((a, b) => a - b),
    label,
  );
}

export function assertTerminal(status: string): void {
  assert.ok(
    ["succeeded", "success", "failed", "rejected", "cancelled"].includes(status),
    `run did not reach a terminal status: ${status}`,
  );
}

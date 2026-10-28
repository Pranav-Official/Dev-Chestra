import type { JsonObject } from "@devchestra/core";

export interface ChainOutput {
  readonly nodeId: string;
  readonly output: unknown;
}

export type ScopeData = Record<string, unknown>;

export function buildScopeData(
  params: JsonObject,
  outputs: readonly ChainOutput[],
  entry?: Readonly<Record<string, unknown>>,
): ScopeData {
  const scope: ScopeData = { start: { ...params } };
  for (const item of outputs) {
    scope[item.nodeId] = item.output;
  }
  if (entry !== undefined) {
    Object.assign(scope, entry);
  }
  return scope;
}

export function outputsBefore(
  chainOrder: readonly string[],
  nodeId: string,
  outputs: Readonly<Record<string, unknown>>,
): ChainOutput[] {
  const result: ChainOutput[] = [];
  for (const id of chainOrder) {
    if (id === nodeId) break;
    if (Object.hasOwn(outputs, id)) result.push({ nodeId: id, output: outputs[id] });
  }
  return result;
}

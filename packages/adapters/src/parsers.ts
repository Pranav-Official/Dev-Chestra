import type { AdapterEvent, StreamParser } from "./types.js";

export abstract class NdjsonParser implements StreamParser {
  #buffer = "";

  feed(chunk: Buffer): AdapterEvent[] {
    this.#buffer += chunk.toString("utf8");
    const events: AdapterEvent[] = [];
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim() !== "") events.push(...this.line(line));
    }
    return events;
  }

  end(): AdapterEvent[] {
    const rest = this.#buffer.trim();
    this.#buffer = "";
    const events = rest === "" ? [] : this.line(rest);
    return [...events, ...this.finished()];
  }

  protected abstract line(line: string): AdapterEvent[];
  protected finished(): AdapterEvent[] {
    return [];
  }
}

export function parseObject(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function clip(text: string, max = 4096): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

export class UsageDelta {
  #in = 0;
  #out = 0;
  #cost = 0;

  take(tokensIn?: number, tokensOut?: number, costUsd?: number): AdapterEvent[] {
    if (tokensIn === undefined && tokensOut === undefined && costUsd === undefined) return [];
    const inDelta = next(this.#in, tokensIn);
    const outDelta = next(this.#out, tokensOut);
    const costDelta = next(this.#cost, costUsd);
    if (tokensIn !== undefined) this.#in = tokensIn;
    if (tokensOut !== undefined) this.#out = tokensOut;
    if (costUsd !== undefined) this.#cost = costUsd;
    if (inDelta === undefined && outDelta === undefined && costDelta === undefined) return [];
    const usage: Extract<AdapterEvent, { t: "usage" }> = { t: "usage", cumulative: false };
    if (inDelta !== undefined) usage.tokensIn = inDelta;
    if (outDelta !== undefined) usage.tokensOut = outDelta;
    if (costDelta !== undefined) usage.costUsd = costDelta;
    return [usage];
  }
}

function next(previous: number, current: number | undefined): number | undefined {
  if (current === undefined) return undefined;
  return current >= previous ? current - previous : current;
}

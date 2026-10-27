import { describe, expect, it } from "vitest";
import type { AdapterEvent } from "../src/index.js";
import { createAdapter } from "../src/index.js";
import { fixtureText } from "./helpers.js";

function parse(events: StreamParserWithEnd, text: string, chunks: number): AdapterEvent[] {
  const size = Math.max(1, Math.ceil(Buffer.byteLength(text) / chunks));
  const buffer = Buffer.from(text);
  const output: AdapterEvent[] = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    output.push(...events.feed(buffer.subarray(offset, Math.min(offset + size, buffer.length))));
  }
  output.push(...events.end());
  return output;
}

interface StreamParserWithEnd {
  feed(chunk: Buffer): AdapterEvent[];
  end(): AdapterEvent[];
}

function parserFor(id: "claude-code" | "codex" | "fake"): StreamParserWithEnd {
  return createAdapter(id).parser();
}

describe("claude parser", () => {
  const text = fixtureText("streams", "claude", "basic.ndjson");

  it("maps session, text, tool, usage and turn_end", () => {
    const events = parse(parserFor("claude-code"), text, 1);
    expect(events.map((event) => event.t)).toEqual([
      "session",
      "text",
      "tool_call",
      "tool_result",
      "usage",
      "turn_end",
    ]);
    expect(events[2]).toMatchObject({ t: "tool_call", name: "mcp__relay__submit_result" });
    expect(events[4]).toEqual({
      t: "usage",
      tokensIn: 100,
      tokensOut: 20,
      costUsd: 0.0123,
      cumulative: false,
    });
  });

  it("is chunk-boundary safe", () => {
    const whole = parse(parserFor("claude-code"), text, 1);
    const split = parse(parserFor("claude-code"), text, 97);
    expect(split).toEqual(whole);
  });

  it("reports cumulative usage as deltas", () => {
    const events = parse(
      parserFor("claude-code"),
      fixtureText("streams", "claude", "cumulative-usage.ndjson"),
      3,
    );
    const usage = events.filter((event) => event.t === "usage");
    expect(usage).toHaveLength(2);
    expect(usage[1]).toMatchObject({ tokensIn: 50, tokensOut: 15 });
    expect((usage[1] as { costUsd: number }).costUsd).toBeCloseTo(0.0077, 10);
  });
});

describe("codex parser", () => {
  it("maps thread, messages, mcp calls and usage", () => {
    const events = parse(parserFor("codex"), fixtureText("streams", "codex", "basic.jsonl"), 1);
    expect(events.map((event) => event.t)).toEqual([
      "session",
      "text",
      "tool_call",
      "tool_result",
      "usage",
      "turn_end",
    ]);
    expect(events[0]).toEqual({ t: "session", sessionId: "thread-1" });
    expect(events[2]).toMatchObject({ t: "tool_call", name: "submit_result" });
    expect(events[3]).toMatchObject({ t: "tool_result", ok: true, summary: "accepted" });
  });

  it("handles command items and multiple usage deltas", () => {
    const events = parse(
      parserFor("codex"),
      fixtureText("streams", "codex", "command-usage.jsonl"),
      5,
    );
    const usage = events.filter((event) => event.t === "usage");
    expect(usage.map((event) => (event.t === "usage" ? event.tokensIn : 0))).toEqual([100, 50]);
    expect(events).toContainEqual({
      t: "tool_call",
      id: "item_1",
      name: "shell",
      input: { command: "echo hi" },
    });
    expect(events).toContainEqual({ t: "tool_result", id: "item_1", ok: true, summary: "hi\n" });
  });
});

describe("fake parser", () => {
  it("maps the explicit fake stream", () => {
    const events = parse(parserFor("fake"), fixtureText("streams", "fake", "basic.ndjson"), 2);
    expect(events.map((event) => event.t)).toEqual([
      "session",
      "notice",
      "text",
      "tool_call",
      "tool_result",
      "turn_end",
    ]);
    expect(events[3]).toMatchObject({ t: "tool_call", name: "submit_result" });
  });
});

describe("classification", () => {
  const exit = {
    code: 0,
    signal: null,
    killedBy: null,
    durationMs: 1,
    pid: 1,
    stdoutBytes: 0,
    stderrBytes: 0,
    sawTurnEnd: false,
    groupStopped: true,
    tail: { stderr: "", stdout: "" },
  } as const;

  it("classifies unknown failures as crash, never guessed quotas", () => {
    const adapter = createAdapter("claude-code");
    expect(adapter.classify(exit, { stderr: "", stdout: "" })).toEqual({ kind: "ok" });
    expect(
      adapter.classify(
        { ...exit, code: 1, signal: null },
        { stderr: "quota exceeded", stdout: "" },
      ),
    ).toEqual({ kind: "crash", exitCode: 1, signal: null });
    expect(
      adapter.classify(
        { ...exit, killedBy: "timeout", code: null, signal: "SIGTERM" },
        { stderr: "", stdout: "" },
      ),
    ).toEqual({ kind: "timeout" });
    expect(
      adapter.classify(
        { ...exit, killedBy: "cancel", code: null, signal: "SIGTERM" },
        { stderr: "", stdout: "" },
      ),
    ).toEqual({ kind: "cancelled" });
  });
});

import { describe, expect, it } from "vitest";
import {
  AGENT_INPUT_CONTEXT_END,
  AGENT_INPUT_CONTEXT_NOTE,
  AGENT_INPUT_CONTEXT_START,
  assertAgentPromptSize,
  canonicalJson,
  composeAgentPrompt,
  MAX_AGENT_PROMPT_BYTES,
  renderAgentInputContext,
  renderSubmitContract,
} from "../src/prompt.js";

describe("submit contract", () => {
  it("names the adapter tool reference and exact-once instruction", () => {
    const contract = renderSubmitContract({ submitRef: "mcp__relay__submit_result" });
    expect(contract).toContain("mcp__relay__submit_result");
    expect(contract).toContain("exactly once");
    expect(contract).toContain("Do not write the result as plain text");
    expect(contract).toContain("fix the listed problems and call it again");
  });

  it("omits context and input sections when unavailable", () => {
    const contract = renderSubmitContract({ submitRef: "submit_result" });
    expect(contract).not.toContain("Shared notes");
    expect(contract).not.toContain("Large inputs");
  });

  it("appends the contract after the rendered prompt", () => {
    const prompt = composeAgentPrompt("Do the task.\n", "(contract)");
    expect(prompt).toBe("Do the task.\n\n(contract)");
    expect(composeAgentPrompt("", "(contract)")).toBe("(contract)");
  });
});

describe("automatic agent input context", () => {
  it("renders a stable marker block with one-line canonical JSON", () => {
    const scope = {
      start: { topic: "relay", zero: 0, flag: false, missing: null },
      research: { repos: [{ name: "a", stars: 0 }, null, false] },
    };
    const context = renderAgentInputContext(scope);
    const lines = context.split("\n");
    expect(lines[0]).toBe(AGENT_INPUT_CONTEXT_NOTE);
    expect(lines[1]).toBe(AGENT_INPUT_CONTEXT_START);
    expect(lines.at(-1)).toBe(AGENT_INPUT_CONTEXT_END);
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[2] as string)).toEqual({
      research: { repos: [{ name: "a", stars: 0 }, null, false] },
      start: { flag: false, missing: null, topic: "relay", zero: 0 },
    });
  });

  it("preserves own keys, arrays, null, false, zero and escapes delimiters", () => {
    const scope = JSON.parse(
      '{"__proto__":{"own":true},"arr":[0,false,null,"</relay_input_context>"],"nested":{"b":2,"a":1}}',
    );
    const json = canonicalJson(scope);
    expect(json).toBe(
      '{"__proto__":{"own":true},"arr":[0,false,null,"\\u003c/relay_input_context>"],"nested":{"a":1,"b":2}}',
    );
    expect(json).not.toContain("</relay_input_context>");
    expect(JSON.parse(json)).toEqual(scope);
  });

  it("always appends context between instructions and contract", () => {
    const context = renderAgentInputContext({ start: { topic: "x" } });
    const prompt = composeAgentPrompt("Do the task.\n", "(contract)", context);
    expect(prompt).toBe(`Do the task.\n\n${context}\n\n(contract)`);
    expect(prompt.indexOf(AGENT_INPUT_CONTEXT_START)).toBeLessThan(prompt.indexOf("(contract)"));
  });

  it("keeps the legacy two-argument composition unchanged", () => {
    expect(composeAgentPrompt("Do the task.\n", "(contract)")).toBe("Do the task.\n\n(contract)");
    expect(composeAgentPrompt("", "(contract)")).toBe("(contract)");
  });

  it("rejects invalid canonical JSON instead of coercing values", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1n]) {
      expect(() => canonicalJson({ value })).toThrowError(
        expect.objectContaining({ code: "E_VALIDATION" }),
      );
    }
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalJson(cycle)).toThrowError(
      expect.objectContaining({ code: "E_VALIDATION" }),
    );
  });

  it("rejects a final prompt over the UTF-8 limit before dispatch", () => {
    expect(() => assertAgentPromptSize("x".repeat(MAX_AGENT_PROMPT_BYTES))).not.toThrow();
    expect(() => assertAgentPromptSize("x".repeat(MAX_AGENT_PROMPT_BYTES + 1))).toThrowError(
      expect.objectContaining({ code: "E_VALIDATION" }),
    );
  });
});

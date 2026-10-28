import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RelayError } from "@relay/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  type CompiledTemplate,
  compileExpression,
  compileTemplate,
  evaluate,
  renderTemplate,
} from "../src/index.js";
import { createNodeExpressionExecutor } from "../src/node/index.js";

const executor = createNodeExpressionExecutor();
const temp = mkdtempSync(path.join(tmpdir(), "relay-schema-"));

afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

describe("JSONata compile policy", () => {
  it("extracts scope roots and built-in calls", () => {
    const compiled = compileExpression("$uppercase(start.topic) & ':' & agent.summary");
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.value.roots).toEqual(["agent", "start"]);
      expect(compiled.value.functions).toEqual(["uppercase"]);
      expect(Object.isFrozen(compiled.value)).toBe(true);
    }
  });

  it("rejects nondeterministic and host-capability functions", () => {
    for (const source of [
      "$now()",
      "$millis()",
      "$fromMillis(0)",
      "$random()",
      "$shuffle([1,2])",
      "$eval('1+1')",
      "$env('HOME')",
      "$uuid()",
    ]) {
      const result = compileExpression(source);
      expect(result.ok, source).toBe(false);
    }
  });

  it("rejects indirect aliasing, dynamic calls, lambdas and apply", () => {
    for (const source of [
      "($x := $eval; $x('1'))",
      "$map([1], $eval)",
      "$map([1], function($v){$v})",
      "start.topic ~> $string",
      "(function($f){$f($f)})(function($f){$f($f)})",
    ]) {
      expect(compileExpression(source).ok, source).toBe(false);
    }
  });

  it("enforces the 4 KiB source cap", () => {
    expect(compileExpression(`"${"a".repeat(5000)}"`).ok).toBe(false);
  });
});

describe("JSONata execution", () => {
  it("evaluates in the Node worker executor", async () => {
    const compiled = compileExpression("$uppercase(start.topic)");
    if (!compiled.ok) throw compiled.error;
    const result = await evaluate(compiled.value, { start: { topic: "hi" } }, { executor });
    expect(result).toEqual({ ok: true, value: "HI" });
  });

  it("requires an explicit executor in the browser-safe main entry", async () => {
    const compiled = compileExpression("start.topic");
    if (!compiled.ok) throw compiled.error;
    const result = await evaluate(compiled.value, { start: { topic: "hi" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('"@relay/schema/node"');
  });

  it("times out a hung injected executor", async () => {
    const compiled = compileExpression("start.topic");
    if (!compiled.ok) throw compiled.error;
    const started = Date.now();
    const result = await evaluate(
      compiled.value,
      { start: { topic: "hi" } },
      {
        timeoutMs: 50,
        executor: { evaluate: () => new Promise<never>(() => undefined) },
      },
    );
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    if (!result.ok) expect(result.error.code).toBe("E_EXPR");
  });

  it("terminates a runaway worker instead of leaking it", async () => {
    const started = Date.now();
    await expect(
      executor.evaluate("(function($f){$f($f)})(function($f){$f($f)})", {}, { timeoutMs: 200 }),
    ).rejects.toBeInstanceOf(RelayError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("caps serialized result size at 64 KiB in the worker and main entry", async () => {
    await expect(executor.evaluate("[1..20000]", {}, { timeoutMs: 2000 })).rejects.toThrow(/65536/);

    const compiled = compileExpression("[1..20000]");
    if (!compiled.ok) throw compiled.error;
    const result = await evaluate(compiled.value, {}, { executor });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("65536");
  });

  it("remains usable after repeated timeout terminations", async () => {
    for (let index = 0; index < 3; index += 1) {
      await expect(
        executor.evaluate("(function($f){$f($f)})(function($f){$f($f)})", {}, { timeoutMs: 100 }),
      ).rejects.toBeInstanceOf(RelayError);
    }
    await expect(executor.evaluate("1 + 1", {}, { timeoutMs: 1000 })).resolves.toBe(2);
  });

  it("does not count worker cold start against the evaluation budget", async () => {
    // The worker takes ~300ms to boot but the evaluation budget is 100ms: the old
    // behavior started the timer at spawn and failed a healthy expression.
    const slowBoot = createNodeExpressionExecutor({
      workerUrl: new URL("./fixtures/slow-boot-worker.mjs", import.meta.url),
    });
    await expect(slowBoot.evaluate("1 + 1", {}, { timeoutMs: 100 })).resolves.toBe(2);
  });

  it("keeps the evaluate() backstop from charging worker cold start", async () => {
    // The public entry wraps the executor in its own backstop timer; it must allow
    // the executor's declared startup time, or it cancels the executor-level fix.
    const slowBoot = createNodeExpressionExecutor({
      workerUrl: new URL("./fixtures/slow-boot-worker.mjs", import.meta.url),
    });
    const compiled = compileExpression("1 + 1");
    if (!compiled.ok) throw compiled.error;
    const result = await evaluate(compiled.value, {}, { timeoutMs: 100, executor: slowBoot });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(2);
  });

  it("still enforces the evaluation budget once the worker is running", async () => {
    const started = Date.now();
    await expect(
      executor.evaluate("(function($f){$f($f)})(function($f){$f($f)})", {}, { timeoutMs: 150 }),
    ).rejects.toThrow(/timed out|stack|depth|exceed/i);
    // Generous upper bound: cold start is outside the budget but the loop must still be cut.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  // NB: the null-comparison retry added here in 7f22aae was reverted (F3):
  // null operands to <, <=, > or >= fail closed with E_EXPR again. Decision
  // scopes expose an unknown confidence as 0 instead, covered by engine tests.
  it("fails closed on null comparison operands", async () => {
    const compiled = compileExpression("d.confidence >= 0.8");
    if (!compiled.ok) throw compiled.error;
    const result = await evaluate(compiled.value, { d: { confidence: null } }, { executor });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_EXPR");
  });
});

describe("templates and shell quoting", () => {
  it("parses escaped braces and rejects raw triple braces", () => {
    const escaped = compileTemplate("literal \\{{ not an expression }}");
    expect(escaped.ok).toBe(true);
    if (escaped.ok)
      expect(escaped.value.parts).toEqual([
        { kind: "literal", text: "literal {{ not an expression }}" },
      ]);
    expect(compileTemplate("{{{ agent.raw }}}").ok).toBe(false);
  });

  it("renders missing values as empty with a warning", async () => {
    const result = await renderTemplate("before {{ agent.missing }} after", {}, { executor });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe("before  after");
      expect(result.value.warnings.map((item) => item.code)).toEqual(["W_TEMPLATE_MISSING"]);
    }
  });

  it("allows unquoted placeholders and quotes every substituted value", async () => {
    const compiled = compileTemplate("printf '%s' {{ agent.answer }}", { shell: true });
    expect(compiled.ok).toBe(true);

    const marker = path.join(temp, "pwned");
    const values = [
      `$(touch ${marker})`,
      `\`touch ${marker}\``,
      "line1\nline2",
      `ok\ntouch ${marker} #`,
      "it's",
      ["$", "{HOME}"].join(""),
      "$'\\x41'",
    ];
    for (const value of values) {
      const rendered = await renderTemplate(
        "printf '%s' {{ agent.answer }}",
        { agent: { answer: value } },
        { shell: true, executor },
      );
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) continue;
      const command = rendered.value.text;
      expect(command).toBe(`printf '%s' ${quote(value)}`);
      const output = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" });
      expect(output).toBe(value);
      expect(existsSync(marker)).toBe(false);
    }
  });

  it("rejects placeholders in shell comments and does not run a newline payload", async () => {
    const marker = path.join(temp, "comment-pwn");
    const value = `ok\ntouch ${marker} #`;

    // Control: the pre-fix rendering (substitution inside a comment) really does
    // execute the second line, so this canary is meaningful.
    execFileSync("/bin/sh", ["-c", `echo # ${quote(value)}\n`]);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker, { force: true });

    const template = "echo # {{ agent.answer }}\n";
    expect(compileTemplate(template, { shell: true }).ok).toBe(false);
    const rendered = await renderTemplate(
      template,
      { agent: { answer: value } },
      { shell: true, executor },
    );
    expect(rendered.ok).toBe(false);
    if (!rendered.ok) expect(rendered.error.message).toContain("comment");
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects a placeholder after a trailing backslash and does not run the payload", async () => {
    const marker = path.join(temp, "slash-pwn");
    const value = `ok\ntouch ${marker} #`;

    execFileSync("/bin/sh", ["-c", `printf '%s' \\${quote(value)}'`]);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker, { force: true });

    const expression = compileExpression("agent.answer");
    if (!expression.ok) throw expression.error;
    const unsafe: CompiledTemplate = {
      source: "manual",
      shell: false,
      parts: [
        { kind: "literal", text: "printf '%s' \\" },
        { kind: "expression", source: "agent.answer", compiled: expression.value },
        { kind: "literal", text: "'" },
      ],
    };
    const rendered = await renderTemplate(
      unsafe,
      { agent: { answer: value } },
      { shell: true, executor },
    );
    expect(rendered.ok).toBe(false);
    if (!rendered.ok) expect(rendered.error.message).toContain("backslash");
    expect(existsSync(marker)).toBe(false);
  });

  it("allows placeholders after a completed comment line", async () => {
    const rendered = await renderTemplate(
      "echo # comment\nprintf '%s' {{ agent.answer }}",
      { agent: { answer: "ok" } },
      { shell: true, executor },
    );
    expect(rendered.ok).toBe(true);
    if (rendered.ok) {
      expect(rendered.value.text).toBe("echo # comment\nprintf '%s' 'ok'");
    }
  });

  it("rejects quoted, backticked, substituted and heredoc placeholder contexts", () => {
    for (const source of [
      "printf '%s' \"{{ agent.answer }}\"",
      "printf '%s' '{{ agent.answer }}'",
      "echo `{{ agent.answer }}`",
      "echo $(printf %s {{ agent.answer }})",
      ["echo $", "{{ agent.answer }}"].join(""),
      "cat <<EOF\n{{ agent.answer }}\nEOF",
      "cat <<< {{ agent.answer }}",
    ]) {
      const result = compileTemplate(source, { shell: true });
      expect(result.ok, source).toBe(false);
    }
  });

  it("quotes an empty shell substitution when the field is missing", async () => {
    const result = await renderTemplate(
      "printf '%s' {{ agent.missing }}",
      {},
      {
        shell: true,
        executor,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe("printf '%s' ''");
      expect(result.value.warnings).toHaveLength(1);
    }
  });
});

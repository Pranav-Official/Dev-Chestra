import { describe, expect, it } from "vitest";
import { assertWindowsCommandLine, spawnOwned, windowsCommandLineLength } from "../src/windows.js";

describe("Windows command-line size", () => {
  it("counts UTF-16, separators, quotes, escaped quotes and trailing backslashes", () => {
    expect(windowsCommandLineLength("a", [])).toBe(4); // "a" + NUL
    expect(windowsCommandLineLength("a", ["", "🙂", 'a"b', "c\\"])).toBe(25);
    expect(windowsCommandLineLength("a", ['\\"', "\\\\"])).toBe(18);
  });

  it("accepts the boundary and rejects oversized arguments without exposing their contents", () => {
    expect(windowsCommandLineLength("a", ["x".repeat(32_760)])).toBe(32_767);
    expect(() => assertWindowsCommandLine("a", ["x".repeat(32_760)])).not.toThrow();
    expect(() => assertWindowsCommandLine("a", ["SECRET".repeat(6_000)])).toThrow(
      expect.objectContaining({ code: "E_VALIDATION" }),
    );
    expect(() => assertWindowsCommandLine("a", ["SECRET".repeat(6_000)])).toThrow(
      /36007 UTF-16 characters/,
    );
  });

  it.skipIf(process.platform !== "win32")("rejects before spawning the Windows supervisor", () => {
    expect(() => spawnOwned(process.execPath, ["x".repeat(33_000)], { env: process.env })).toThrow(
      expect.objectContaining({ code: "E_VALIDATION" }),
    );
  });
});

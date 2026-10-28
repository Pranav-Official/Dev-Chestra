import { isFakeCliEnabled } from "@relay/schema";
import { describe, expect, it } from "vitest";
import { isFakeProviderEnabled } from "../src/index.js";

describe("fake provider gate", () => {
  it("follows the single RELAY_ALLOW_FAKE gate owned by @relay/schema", () => {
    const cases: Array<[string | undefined, boolean]> = [
      ["1", true],
      ["true", true],
      ["0", false],
      ["false", false],
      ["", false],
      ["yes", false],
      [undefined, false],
    ];
    for (const [value, expected] of cases) {
      const env: NodeJS.ProcessEnv = value === undefined ? {} : { RELAY_ALLOW_FAKE: value };
      expect(isFakeProviderEnabled(env)).toBe(expected);
      expect(isFakeProviderEnabled(env)).toBe(isFakeCliEnabled(env));
    }
  });
});

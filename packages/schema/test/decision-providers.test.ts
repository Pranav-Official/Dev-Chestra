import { describe, expect, it } from "vitest";
import {
  DECISION_PROVIDER_LABELS,
  DECISION_PROVIDERS,
  isDecisionProviderId,
} from "../src/index.js";

describe("decision providers", () => {
  it("has a non-empty label for every provider id", () => {
    for (const id of DECISION_PROVIDERS) {
      expect(DECISION_PROVIDER_LABELS[id].length).toBeGreaterThan(0);
    }
    expect(Object.keys(DECISION_PROVIDER_LABELS).sort()).toEqual([...DECISION_PROVIDERS].sort());
  });

  it("narrows only known provider ids", () => {
    expect(isDecisionProviderId("typesafe-jev")).toBe(true);
    expect(isDecisionProviderId("cloudflare-clef")).toBe(true);
    expect(isDecisionProviderId("cloudflare-clef-flash")).toBe(true);
    expect(isDecisionProviderId("openai")).toBe(false);
    expect(isDecisionProviderId("")).toBe(false);
    expect(isDecisionProviderId(undefined)).toBe(false);
  });
});

import { PROD_CLIS } from "@relay/schema";
import { describe, expect, it } from "vitest";
import { getProvider, prodProviderIds } from "../src/index.js";

describe("PROD_CLIS provider coverage", () => {
  it("registers a provider with a non-empty label for every prod CLI", () => {
    for (const id of PROD_CLIS) {
      const provider = getProvider(id);
      expect(provider.id).toBe(id);
      expect(provider.label.length).toBeGreaterThan(0);
    }
  });

  it("prodProviderIds returns exactly PROD_CLIS", () => {
    expect(prodProviderIds()).toEqual([...PROD_CLIS]);
  });
});

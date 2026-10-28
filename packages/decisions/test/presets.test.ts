import { DECISION_PROVIDERS } from "@devchestra/schema";
import { describe, expect, it } from "vitest";
import { DECISION_PRESETS, resolvePresetUrl } from "../src/presets.js";

describe("decision presets", () => {
  it("covers every provider id exactly once", () => {
    expect(Object.keys(DECISION_PRESETS).sort()).toEqual([...DECISION_PROVIDERS].sort());
  });

  it("matches the section 1 table", () => {
    const jev = DECISION_PRESETS["typesafe-jev"];
    expect(jev.method).toBe("POST");
    expect(jev.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(jev.bodyModel).toBe("jev-latest");
    expect(jev.requiredEnv).toEqual(["TYPESAFE_API_KEY"]);

    const clef = DECISION_PRESETS["cloudflare-clef"];
    expect(clef.method).toBe("POST");
    expect(clef.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/cloudflare/clef",
    );
    expect(clef.bodyModel).toBe("clef");
    expect(clef.requiredEnv).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AUTH_TOKEN"]);

    const flash = DECISION_PRESETS["cloudflare-clef-flash"];
    expect(flash.method).toBe("POST");
    expect(flash.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run/@cf/cloudflare/clef-flash",
    );
    expect(flash.bodyModel).toBe("clef-flash");
    expect(flash.requiredEnv).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AUTH_TOKEN"]);
  });

  it("uses the default 20 s timeout for every preset", () => {
    for (const preset of Object.values(DECISION_PRESETS)) {
      expect(preset.timeoutMs).toBe(20_000);
    }
  });

  it("substitutes the account id only in Cloudflare URLs", () => {
    expect(resolvePresetUrl(DECISION_PRESETS["cloudflare-clef"], "acct-1")).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/@cf/cloudflare/clef",
    );
    expect(resolvePresetUrl(DECISION_PRESETS["typesafe-jev"], "acct-1")).toBe(
      "https://api.typesafe.ai/v1/systemone",
    );
  });
});

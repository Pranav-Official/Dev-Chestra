import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";

describe("relay doctor decision providers", () => {
  it("lists each provider as ready or missing with variable NAMES only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-doctor-dec-"));
    try {
      const sentinel = `sentinel-${Date.now()}-key`;
      const previous = process.env.TYPESAFE_API_KEY;
      process.env.TYPESAFE_API_KEY = sentinel;
      // Keep Cloudflare vars absent so both states appear.
      const prevAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
      const prevToken = process.env.CLOUDFLARE_AUTH_TOKEN;
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
      delete process.env.CLOUDFLARE_AUTH_TOKEN;
      let result;
      try {
        result = await runDoctor(join(dir, "data"));
      } finally {
        if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
        else process.env.TYPESAFE_API_KEY = previous;
        if (prevAccount !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = prevAccount;
        if (prevToken !== undefined) process.env.CLOUDFLARE_AUTH_TOKEN = prevToken;
      }
      const names = result.checks.map((check) => check.name);
      expect(names).toContain("decision-typesafe-jev");
      expect(names).toContain("decision-cloudflare-clef");
      expect(names).toContain("decision-cloudflare-clef-flash");
      const jev = result.checks.find((check) => check.name === "decision-typesafe-jev");
      expect(jev?.status).toBe("pass");
      const clef = result.checks.find((check) => check.name === "decision-cloudflare-clef");
      expect(clef?.status).toBe("warn");
      expect(clef?.message).toContain("CLOUDFLARE_ACCOUNT_ID");
      expect(clef?.message).toContain("CLOUDFLARE_AUTH_TOKEN");
      // No key value anywhere in doctor output.
      expect(JSON.stringify(result)).not.toContain(sentinel);
      // Missing keys are advisory: doctor stays ok.
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

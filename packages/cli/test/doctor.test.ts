import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisionService } from "@relay/decisions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StandinHandle } from "../../../tools/fixtures/decisions/standin.mjs";
import { startStandin } from "../../../tools/fixtures/decisions/standin.mjs";
import { type DoctorResult, runDoctor } from "../src/doctor.js";

const FAKE_ENV = {
  TYPESAFE_API_KEY: "test-typesafe-key",
  CLOUDFLARE_ACCOUNT_ID: "test-cf-account",
  CLOUDFLARE_AUTH_TOKEN: "test-cf-token",
};
const NEEDLES = ["test-typesafe-key", "test-cf-token", "test-cf-account"];

let standin: StandinHandle;

beforeEach(async () => {
  standin = await startStandin();
});

afterEach(async () => {
  await standin.close();
});

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
      let result: DoctorResult;
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

  it("makes no network calls without --probe-decisions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-doctor-noprobe-"));
    try {
      let fetches = 0;
      const decisions = createDecisionService({
        env: { TYPESAFE_API_KEY: "sentinel-probe-key" },
        dotenvPath: null,
        fetchImpl: (async () => {
          fetches += 1;
          throw new Error("network must not be touched");
        }) as typeof fetch,
      });
      const result = await runDoctor(join(dir, "data"), { decisions });
      expect(fetches).toBe(0);
      expect(result.checks.some((check) => check.name.startsWith("decision-probe-"))).toBe(false);
      expect(result.checks.find((check) => check.name === "decision-typesafe-jev")?.status).toBe(
        "pass",
      );
      expect(JSON.stringify(result)).not.toContain("sentinel-probe-key");
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("probes each ready provider once with a redacted shape summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-doctor-probe-"));
    try {
      // Only Jev is ready, so only Jev is probed (one request).
      const decisions = createDecisionService({
        env: { TYPESAFE_API_KEY: FAKE_ENV.TYPESAFE_API_KEY },
        dotenvPath: null,
        baseUrlOverride: standin.origin,
      });
      const result = await runDoctor(join(dir, "data"), {
        probeDecisions: true,
        decisions,
      });
      const probes = result.checks.filter((check) => check.name.startsWith("decision-probe-"));
      expect(probes.map((check) => check.name)).toEqual(["decision-probe-typesafe-jev"]);
      expect(probes[0]?.status).toBe("pass");
      expect(probes[0]?.message).toContain("probe ok in");
      expect(probes[0]?.message).toContain("model=jev-latest");
      expect(probes[0]?.message).toContain("wrapped=no");
      expect(probes[0]?.message).toContain("answer=[type,noul]");
      expect(probes[0]?.message).toContain("confidence=no");
      expect(probes[0]?.message).toContain("usage=yes");
      expect(standin.requests()).toHaveLength(1);
      const haystack = JSON.stringify(result);
      for (const needle of NEEDLES) {
        expect(haystack).not.toContain(needle);
      }
      // A bare probe answer carries no probability value in the summary.
      expect(haystack).not.toContain("0.75");
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a failed probe without key material", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-doctor-probefail-"));
    try {
      standin.setNext(["error-500", "error-500", "error-500"]);
      const decisions = createDecisionService({
        env: { TYPESAFE_API_KEY: FAKE_ENV.TYPESAFE_API_KEY },
        dotenvPath: null,
        baseUrlOverride: standin.origin,
        sleep: async () => undefined,
      });
      const result = await runDoctor(join(dir, "data"), {
        probeDecisions: true,
        decisions,
      });
      const probe = result.checks.find((check) => check.name === "decision-probe-typesafe-jev");
      expect(probe?.status).toBe("fail");
      expect(probe?.message).toContain("probe failed in");
      expect(result.ok).toBe(false);
      const haystack = JSON.stringify(result);
      for (const needle of NEEDLES) {
        expect(haystack).not.toContain(needle);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

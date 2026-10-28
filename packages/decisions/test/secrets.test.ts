import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDecisionSecrets, missingSecretNames, redactSecrets } from "../src/secrets.js";

function tempDotenv(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-decisions-"));
  const path = join(dir, ".env");
  writeFileSync(path, content);
  return path;
}

describe("decision secrets", () => {
  it("prefers process.env over .env", () => {
    const path = tempDotenv("TYPESAFE_API_KEY=file-key\nCLOUDFLARE_AUTH_TOKEN=file-token\n");
    const secrets = loadDecisionSecrets({
      env: { TYPESAFE_API_KEY: "env-key" },
      dotenvPath: path,
    });
    expect(secrets.TYPESAFE_API_KEY).toBe("env-key");
    expect(secrets.CLOUDFLARE_AUTH_TOKEN).toBe("file-token");
  });

  it("falls back to .env when the environment is empty", () => {
    const path = tempDotenv("TYPESAFE_API_KEY=file-key\nCLOUDFLARE_ACCOUNT_ID=file-acct\n");
    const secrets = loadDecisionSecrets({ env: {}, dotenvPath: path });
    expect(secrets).toEqual({
      TYPESAFE_API_KEY: "file-key",
      CLOUDFLARE_ACCOUNT_ID: "file-acct",
    });
  });

  it("ignores .env names outside the allowlist", () => {
    const path = tempDotenv("UNRELATED_VAR=whatever\nTYPESAFE_API_KEY=k\n");
    const secrets = loadDecisionSecrets({ env: {}, dotenvPath: path });
    expect(secrets).toEqual({ TYPESAFE_API_KEY: "k" });
  });

  it("treats empty strings as missing and skips unreadable files", () => {
    const path = tempDotenv("TYPESAFE_API_KEY=\n");
    const secrets = loadDecisionSecrets({
      env: { CLOUDFLARE_AUTH_TOKEN: "" },
      dotenvPath: path,
    });
    expect(secrets).toEqual({});
    expect(loadDecisionSecrets({ env: {}, dotenvPath: join(tmpdir(), "no-such.env") })).toEqual({});
    expect(loadDecisionSecrets({ env: { TYPESAFE_API_KEY: "k" }, dotenvPath: null })).toEqual({
      TYPESAFE_API_KEY: "k",
    });
  });

  it("never mutates process.env", () => {
    const before = { ...process.env };
    loadDecisionSecrets();
    loadDecisionSecrets({ env: {}, dotenvPath: null });
    expect(process.env).toEqual(before);
  });

  it("reports only missing NAMES", () => {
    expect(
      missingSecretNames({ TYPESAFE_API_KEY: "k" }, ["TYPESAFE_API_KEY", "CLOUDFLARE_AUTH_TOKEN"]),
    ).toEqual(["CLOUDFLARE_AUTH_TOKEN"]);
  });

  it("redacts every known value and nothing else", () => {
    const secrets = { TYPESAFE_API_KEY: "secret-abc", CLOUDFLARE_AUTH_TOKEN: "tok" } as const;
    expect(redactSecrets("key secret-abc and tok here", { ...secrets })).toBe(
      "key [redacted] and [redacted] here",
    );
    expect(redactSecrets("nothing to hide", { ...secrets })).toBe("nothing to hide");
  });

  it("redacts namespaced values without leaking partial overlaps", () => {
    const out = redactSecrets("tok tok-extra", { CLOUDFLARE_AUTH_TOKEN: "tok-extra" });
    expect(out).toBe("tok [redacted]");
  });
});

describe("account id format", () => {
  const required = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AUTH_TOKEN"] as const;

  it("accepts ids that are a single safe path segment", () => {
    for (const id of ["0123456789abcdef0123456789abcdef", "acct_1-A"]) {
      expect(
        missingSecretNames({ CLOUDFLARE_ACCOUNT_ID: id, CLOUDFLARE_AUTH_TOKEN: "t" }, required),
      ).toEqual([]);
    }
  });

  it("reports malformed ids as missing by name, never by value", () => {
    const bad = [
      "../../user/tokens/verify",
      "a/b",
      "a?x=1",
      "a#b",
      "a b",
      "a\nb",
      "$&",
      "%2e%2e",
      "x".repeat(65),
      "",
    ];
    for (const id of bad) {
      expect(
        missingSecretNames({ CLOUDFLARE_ACCOUNT_ID: id, CLOUDFLARE_AUTH_TOKEN: "t" }, required),
      ).toEqual(["CLOUDFLARE_ACCOUNT_ID"]);
    }
  });
});

import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM helper without type declarations
import * as h from "../scripts/lib/setup-helpers.mjs";

const REPO = [
  "# comment",
  "TYPESAFE_API_KEY=ts-key",
  "CLOUDFLARE_ACCOUNT_ID=acct",
  "CLOUDFLARE_AUTH_TOKEN=cf-token",
  "UNRELATED_SECRET=nope",
  "",
].join("\n");

describe("setup helpers", () => {
  it("picks only the allowlisted secrets, ignoring anything else", () => {
    expect(h.pickSecrets(REPO)).toEqual({
      TYPESAFE_API_KEY: "ts-key",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_AUTH_TOKEN: "cf-token",
    });
    expect(h.pickSecrets("TYPESAFE_API_KEY=\nOTHER=x")).toEqual({});
  });

  it("plans a write when the config file has no keys yet", () => {
    const plan = h.planKeys(REPO, null);
    expect(plan.action).toBe("write");
    expect(plan.add).toEqual([
      "TYPESAFE_API_KEY",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_AUTH_TOKEN",
    ]);
  });

  it("only adds the missing names and never overwrites an existing value", () => {
    const config = "TYPESAFE_API_KEY=already-set\n";
    const plan = h.planKeys(REPO, config);
    expect(plan.action).toBe("write");
    expect(plan.add).toEqual(["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AUTH_TOKEN"]);
    const merged = h.mergedConfigText(config, REPO, plan.add);
    expect(merged).toContain("TYPESAFE_API_KEY=already-set\n");
    expect(merged).not.toContain("ts-key");
    expect(merged).toContain("CLOUDFLARE_ACCOUNT_ID=acct\n");
    expect(merged).not.toContain("UNRELATED_SECRET");
  });

  it("keeps existing comments and other lines in the config file", () => {
    const config = "# mine\nCUSTOM=1";
    const merged = h.mergedConfigText(config, REPO, ["TYPESAFE_API_KEY"]);
    expect(merged).toBe("# mine\nCUSTOM=1\nTYPESAFE_API_KEY=ts-key\n");
  });

  it("is a no-op when everything is already there, or there is nothing to copy", () => {
    expect(h.planKeys(REPO, REPO).action).toBe("complete");
    expect(h.planKeys(null, null).action).toBe("none");
    expect(h.planKeys("OTHER=1", null).action).toBe("none");
    expect(h.planKeys(null, "TYPESAFE_API_KEY=k")).toMatchObject({ action: "complete" });
  });

  it("resolves the config dir like the server does", () => {
    expect(h.configDir({ DEVCHESTRA_CONFIG_DIR: "/c" }, "/home/u")).toBe("/c");
    expect(h.configDir({ XDG_CONFIG_HOME: "/x" }, "/home/u")).toBe("/x/devchestra");
    expect(h.configDir({}, "/home/u")).toBe("/home/u/.config/devchestra");
  });

  it("flags files that other users can read", () => {
    expect(h.modeTooOpen(0o644)).toBe(true);
    expect(h.modeTooOpen(0o640)).toBe(true);
    expect(h.modeTooOpen(0o600)).toBe(false);
  });

  it("checks PATH membership and the Node version", () => {
    expect(h.pathContains("/a:/b:/c", "/b")).toBe(true);
    expect(h.pathContains("/a:/b", "/bb")).toBe(false);
    expect(h.pathContains(undefined, "/a")).toBe(false);
    expect(h.nodeMajorOk("v26.11.1")).toBe(true);
    expect(h.nodeMajorOk("22.0.0")).toBe(true);
    expect(h.nodeMajorOk("v20.19.0")).toBe(false);
  });
});

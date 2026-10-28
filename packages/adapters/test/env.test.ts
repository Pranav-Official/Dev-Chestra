import { describe, expect, it } from "vitest";
import { buildChildEnv } from "../src/index.js";

const base: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/test",
  LC_ALL: "C.UTF-8",
  ANTHROPIC_API_KEY: "anthropic-key",
  GITHUB_TOKEN: "github-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  DEVCHESTRA_EXEC_TOKEN: "devchestra-secret",
  NODE_OPTIONS: "--require=evil",
  RANDOM_UNLISTED: "drop-me",
};

describe("buildChildEnv", () => {
  it("never copies process env wholesale", () => {
    const env = buildChildEnv("claude-code", { base });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-key");
    expect(env.LC_ALL).toBe("C.UTF-8");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.DEVCHESTRA_EXEC_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.RANDOM_UNLISTED).toBeUndefined();
    expect(env.TERM).toBe("dumb");
    expect(env.CI).toBe("1");
  });

  it("allows explicitly declared non-reserved names", () => {
    const env = buildChildEnv("codex", {
      base,
      nodeEnvNames: ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY"],
      nodeEnv: { MY_NODE_VALUE: "1" },
    });
    expect(env.GITHUB_TOKEN).toBe("github-secret");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("aws-secret");
    expect(env.MY_NODE_VALUE).toBe("1");
  });

  it("refuses DEVCHESTRA_* declarations and loader/injection variables", () => {
    expect(() =>
      buildChildEnv("claude-code", { base, nodeEnvNames: ["DEVCHESTRA_EXEC_TOKEN"] }),
    ).toThrow();
    expect(() =>
      buildChildEnv("claude-code", { base, nodeEnv: { DEVCHESTRA_EXEC_TOKEN: "x" } }),
    ).toThrow();
    expect(() =>
      buildChildEnv("claude-code", { base, nodeEnv: { NODE_OPTIONS: "--x" } }),
    ).toThrow();
    expect(() => buildChildEnv("claude-code", { base, cliEnv: { LD_PRELOAD: "/x" } })).toThrow();
  });

  it("accepts DEVCHESTRA_* only from trusted injected values", () => {
    const env = buildChildEnv("fake", {
      base,
      injected: {
        DEVCHESTRA_EXEC_TOKEN: "token",
        DEVCHESTRA_GATEWAY_URL: "http://127.0.0.1:1",
        FAKE_AGENT_SCRIPT: "[]",
      },
    });
    expect(env.DEVCHESTRA_EXEC_TOKEN).toBe("token");
    expect(env.FAKE_AGENT_SCRIPT).toBe("[]");
  });
});

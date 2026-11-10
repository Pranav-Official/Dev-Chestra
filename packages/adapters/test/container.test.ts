import { describe, expect, it } from "vitest";
import { type ContainerExecution, containerArguments, containerBaseEnv } from "../src/container.js";

const spec: ContainerExecution = {
  runtime: {
    version: 1,
    bin: "podman",
    image: `sha256:${"a".repeat(64)}`,
    uid: 1000,
    gid: 1000,
    selinux: true,
    endpoint: "local:/tmp/storage",
    owner: "a".repeat(20),
  },
  dataDir: "/data",
  runId: "run",
  executionId: "agent",
  cwd: "/data/clone",
  mounts: [{ source: "/tmp/gateway", target: "/tmp/gateway", readOnly: true }],
};
describe("container launch", () => {
  it("keeps secrets out of argv, shares SELinux mounts, and applies hardening", () => {
    const args = containerArguments(
      spec,
      {
        bin: "codex",
        args: ["exec"],
        cwd: spec.cwd,
        env: { GH_TOKEN: "secret-token", HOME: "/home/devchestra" },
        files: [],
      },
      "name",
    );
    expect(args.join(" ")).not.toContain("secret-token");
    expect(args).toContain("GH_TOKEN");
    expect(args).toContain("HOME=/home/devchestra");
    expect(args).toContain("/data/clone:/data/clone:rw,z");
    expect(args).toContain("/tmp/gateway:/tmp/gateway:ro,z");
    expect(args).toContain("--userns=keep-id");
    expect(args).toContain("--cap-drop=ALL");
  });
  it("uses container paths and excludes host proxy and home overrides", () => {
    const env = containerBaseEnv(
      {
        HOME: "/host",
        PATH: "/host/bin",
        CODEX_HOME: "/host/codex",
        HTTP_PROXY: "http://127.0.0.1:123",
        OPENAI_API_KEY: "key",
      },
      "codex",
    );
    expect(env.HOME).toBe("/home/devchestra");
    expect(env.PATH).not.toContain("/host");
    expect(env.CODEX_HOME).toBe("/home/devchestra/.codex");
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBe("key");
  });
});

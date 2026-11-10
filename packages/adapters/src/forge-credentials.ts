import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DevChestraError } from "@devchestra/core";
import { runtimeEnv } from "./container.js";

export function forgeCredentialFile(dataDir: string, projectRoot: string): string {
  const project = createHash("sha256").update(realpathSync(projectRoot)).digest("hex");
  return join(dataDir, "sandbox", "credentials", `${project}.json`);
}
/** Secrets stay out of argv, generated files in exec mounts, and persisted workflow data. */
export function resolveForgeCredentials(
  dataDir: string,
  projectRoot: string,
  requested: unknown,
): { env: Record<string, string>; secrets: string[] } {
  if (requested === undefined || (Array.isArray(requested) && requested.length === 0))
    return { env: {}, secrets: [] };
  if (!Array.isArray(requested) || requested.some((item) => item !== "github"))
    throw new DevChestraError(
      "E_VALIDATION",
      "Unsupported container credential; supported: github",
    );
  const file = forgeCredentialFile(dataDir, projectRoot);
  let record: { token?: string; account?: string };
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error("credential file must be a private regular file");
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new DevChestraError(
      "E_VALIDATION",
      "GitHub credential unavailable; run devchestra sandbox login github --project <dir> --stdin (or --account <user>)",
      { cause: error },
    );
  }
  let token = record.token;
  if (record.account) {
    const result = spawnSync(
      "gh",
      ["auth", "token", "--hostname", "github.com", "--user", record.account],
      { env: runtimeEnv(), encoding: "utf8", timeout: 10_000 },
    );
    if (result.status !== 0)
      throw new DevChestraError("E_VALIDATION", "Cannot resolve the selected host GitHub account");
    token = result.stdout.trim();
  }
  if (!token || /[\r\n\0]/.test(token))
    throw new DevChestraError("E_VALIDATION", "GitHub credential is empty or invalid");
  return {
    env: {
      GH_TOKEN: token,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_1: "!gh auth git-credential",
    },
    secrets: [token],
  };
}

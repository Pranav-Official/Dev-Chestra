#!/usr/bin/env node
// One command to set DevChestra up on this machine:
//   pnpm setup:global [--dry-run] [--no-env] [--no-restart]
//
// Installs and builds, links the `devchestra` command globally, copies the decision
// API keys (names allowlisted, never printed) to ~/.config/devchestra/.env, and
// restarts a running server if it is idle. Safe to run again at any time.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configDir,
  mergedConfigText,
  modeTooOpen,
  nodeMajorOk,
  pathContains,
  planKeys,
} from "./lib/setup-helpers.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliDir = join(root, "packages", "cli");
const cliMain = join(cliDir, "dist", "main.js");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const skipEnv = args.has("--no-env");
const skipRestart = args.has("--no-restart");

const say = {
  step: (text) => console.log(`\n${text}`),
  ok: (text) => console.log(`  ✓ ${text}`),
  note: (text) => console.log(`  · ${text}`),
  warn: (text) => console.log(`  ! ${text}`),
  fail: (text) => console.error(`  ✗ ${text}`),
};

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    ...options,
  });
}

function die(message, hint) {
  say.fail(message);
  if (hint) console.error(`    ${hint}`);
  process.exit(1);
}

function cli(commandArgs) {
  return run(process.execPath, [cliMain, ...commandArgs]);
}

function serverStatus() {
  if (!existsSync(cliMain)) return null;
  const result = cli(["status", "--json"]);
  try {
    return JSON.parse(result.stdout.split("\n").filter(Boolean).pop() ?? "null");
  } catch {
    return null;
  }
}

console.log(`DevChestra setup${dryRun ? " (dry run: nothing will be changed)" : ""}`);

// 1. prerequisites
say.step("1. Checking prerequisites");
if (!nodeMajorOk(process.version))
  die(`Node ${process.version} is too old.`, "Install Node 22 or newer.");
say.ok(`Node ${process.version}`);
const pnpmVersion = run("pnpm", ["--version"]);
if (pnpmVersion.status !== 0)
  die("pnpm was not found.", "Install pnpm 10.14 or newer: https://pnpm.io/installation");
say.ok(`pnpm ${pnpmVersion.stdout.trim()}`);

// 2. install + build
say.step("2. Installing and building");
if (dryRun) {
  say.note("would run: pnpm install --frozen-lockfile && pnpm build");
} else {
  if (run("pnpm", ["install", "--frozen-lockfile"], { inherit: true }).status !== 0) {
    die("pnpm install failed.");
  }
  if (run("pnpm", ["build"], { inherit: true }).status !== 0) die("pnpm build failed.");
  if (!existsSync(cliMain)) die("The build did not produce packages/cli/dist/main.js.");
  chmodSync(cliMain, 0o755);
  say.ok("built");
}

// 3. global command
say.step("3. Linking the global `devchestra` command");
const binDir = run("pnpm", ["bin", "-g"]).stdout.trim();
if (dryRun) {
  say.note(`would run: pnpm link --global (in packages/cli) -> ${binDir || "pnpm global bin"}`);
} else {
  const link = run("pnpm", ["link", "--global"], { cwd: cliDir });
  if (link.status !== 0) {
    const text = `${link.stdout}${link.stderr}`;
    if (/NO_GLOBAL_BIN_DIR|global bin/iu.test(text)) {
      die(
        "pnpm has no global bin directory yet.",
        "Run `pnpm setup` once, open a new terminal, then run this again.",
      );
    }
    die("pnpm link --global failed.", text.trim().split("\n").slice(-3).join("\n    "));
  }
  say.ok(`linked -> ${join(binDir, "devchestra")}`);
  const version = run(join(binDir, "devchestra"), ["version"]);
  if (version.status === 0) say.ok(version.stdout.trim());
  else say.warn("the linked command did not run; try opening a new terminal");
}
if (binDir && !pathContains(process.env.PATH, binDir)) {
  say.warn(`${binDir} is not on your PATH.`);
  say.note(`add this to your shell profile:  export PATH="${binDir}:$PATH"`);
}

// 4. API keys
say.step("4. Decision API keys");
if (skipEnv) {
  say.note("skipped (--no-env)");
} else {
  const repoEnvPath = join(root, ".env");
  const targetDir = configDir();
  const targetPath = join(targetDir, ".env");
  const repoText = existsSync(repoEnvPath) ? readFileSync(repoEnvPath, "utf8") : null;
  const configText = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
  const plan = planKeys(repoText, configText);
  if (plan.action === "none") {
    say.note(`no keys found in ${repoEnvPath} or ${targetPath}`);
    say.note("copy .env.example to ~/.config/devchestra/.env and fill in the keys you use");
  } else if (plan.action === "complete") {
    say.ok(`${targetPath} already has ${plan.have.join(", ")}`);
  } else if (dryRun) {
    say.note(`would add ${plan.add.join(", ")} to ${targetPath} (mode 600)`);
  } else {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    writeFileSync(targetPath, mergedConfigText(configText, repoText, plan.add), { mode: 0o600 });
    chmodSync(targetPath, 0o600);
    say.ok(`added ${plan.add.join(", ")} to ${targetPath} (mode 600)`);
  }
  if (repoText !== null && modeTooOpen(statSync(repoEnvPath).mode)) {
    if (dryRun) say.note(`would restrict ${repoEnvPath} to mode 600 (others can read it now)`);
    else {
      chmodSync(repoEnvPath, 0o600);
      say.ok(`restricted ${repoEnvPath} to mode 600 (other users could read it)`);
    }
  }
}

// 5. running server
say.step("5. Server");
const status = serverStatus();
if (status === null || status.state !== "running") {
  say.note("no server is running; start one with `devchestra start`");
} else if (skipRestart) {
  say.note(`server running at ${status.url}; restart it to pick up changes (skipped)`);
} else if ((status.activeRuns ?? 0) > 0) {
  say.warn(
    `${status.activeRuns} run(s) active; not restarting. Run \`devchestra stop\` when they finish.`,
  );
} else if (dryRun) {
  say.note(`would restart the idle server at ${status.url}`);
} else {
  const stop = cli(["stop"]);
  if (stop.status !== 0) {
    say.warn(`could not stop the server: ${stop.stderr.trim() || stop.stdout.trim()}`);
  } else {
    spawn(process.execPath, [cliMain, "start"], { detached: true, stdio: "ignore" }).unref();
    let again = null;
    for (let tries = 0; tries < 40 && again?.state !== "running"; tries += 1) {
      await new Promise((done) => setTimeout(done, 400));
      again = serverStatus();
    }
    if (again?.state === "running") say.ok(`restarted at ${again.url} (opened in your browser)`);
    else say.warn("restarted but it did not report running yet; check `devchestra status`");
  }
}

console.log(`\nDone. Try:  devchestra status${dryRun ? "   (nothing was changed)" : ""}`);

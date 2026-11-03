#!/usr/bin/env node
// One command to set DevChestra up on this machine:
//   pnpm|npm|bun run setup:global [--dry-run] [--no-env] [--no-restart]
//
// Installs and builds, links the `devchestra` command globally, copies the decision
// API keys (names allowlisted, never printed) to ~/.config/devchestra/.env, and
// restarts a running server if it is idle. Safe to run again at any time.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  appendSecrets,
  configDir,
  mergedConfigText,
  modeTooOpen,
  nodeMajorOk,
  pathContains,
  pickSecrets,
  planKeys,
  providerGaps,
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
    // pnpm/npm/bun are .cmd shims on Windows, which only spawn through a shell.
    shell: process.platform === "win32" && command !== process.execPath,
    ...options,
  });
}

// Ask one question; secret answers are not echoed to the terminal.
async function ask(question, { secret = false } = {}) {
  let muteOutput = false;
  const muted = new Writable({
    write(chunk, _encoding, done) {
      if (!muteOutput) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  const pending = rl.question(question);
  muteOutput = secret;
  const answer = await pending;
  rl.close();
  if (secret) process.stdout.write("\n");
  return answer.trim();
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
// The package manager that launched this script (pnpm, npm or bun); otherwise the first installed.
const pm = (() => {
  const fromAgent = /^(pnpm|bun|npm)\//u.exec(process.env.npm_config_user_agent ?? "")?.[1];
  if (fromAgent) return fromAgent;
  return ["pnpm", "npm", "bun"].find((name) => run(name, ["--version"]).status === 0) ?? "pnpm";
})();
const pmVersion = run(pm, ["--version"]);
if (pmVersion.status !== 0)
  die(`${pm} was not found.`, "Install pnpm, npm or bun and run this again.");
say.ok(`${pm} ${pmVersion.stdout.trim()}`);

// 2. install + build
say.step("2. Installing and building");
const lockfile = { pnpm: "pnpm-lock.yaml", npm: "package-lock.json", bun: "bun.lock" }[pm];
const installArgs = existsSync(join(root, lockfile))
  ? pm === "npm"
    ? ["ci"]
    : ["install", "--frozen-lockfile"]
  : ["install"];
if (dryRun) {
  say.note(`would run: ${pm} ${installArgs.join(" ")} && ${pm} run build`);
} else {
  if (run(pm, installArgs, { inherit: true }).status !== 0) die(`${pm} ${installArgs[0]} failed.`);
  if (run(pm, ["run", "build"], { inherit: true }).status !== 0) die(`${pm} run build failed.`);
  if (!existsSync(cliMain)) die("The build did not produce packages/cli/dist/main.js.");
  chmodSync(cliMain, 0o755);
  say.ok("built");
}

// 3. global command
say.step("3. Linking the global `devchestra` command");
const globalBin = () => {
  if (pm === "pnpm") return run("pnpm", ["bin", "-g"]).stdout.trim();
  if (pm === "bun") return run("bun", ["pm", "bin", "-g"]).stdout.trim();
  const prefix = run("npm", ["prefix", "-g"]).stdout.trim();
  return prefix && (process.platform === "win32" ? prefix : join(prefix, "bin"));
};
const binDir = globalBin();
if (dryRun) {
  say.note(`would link packages/cli as \`devchestra\` -> ${binDir || `${pm} global bin`}`);
} else if (pm === "bun") {
  // bun has no equivalent of `npm link` that puts a workspace bin on PATH, so symlink it.
  if (!binDir) die("bun has no global bin directory.", "Run `bun pm bin -g` to check your setup.");
  mkdirSync(binDir, { recursive: true });
  const target = join(binDir, "devchestra");
  if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) rmSync(target);
  symlinkSync(cliMain, target);
} else {
  const link = run(pm, pm === "pnpm" ? ["link", "--global"] : ["link"], { cwd: cliDir });
  if (link.status !== 0) {
    const text = `${link.stdout}${link.stderr}`;
    if (pm === "pnpm" && /NO_GLOBAL_BIN_DIR|global bin/iu.test(text)) {
      die(
        "pnpm has no global bin directory yet.",
        "Run `pnpm setup` once, open a new terminal, then run this again.",
      );
    }
    die(`${pm} link failed.`, text.trim().split("\n").slice(-3).join("\n    "));
  }
}
if (!dryRun) {
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
  // Offer to enter whatever the decision providers still lack (interactive terminals only).
  const interactive = !dryRun && process.stdin.isTTY && process.stdout.isTTY;
  const currentText = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : configText;
  const gaps = providerGaps(Object.keys(pickSecrets(currentText ?? "")));
  if (gaps.length === 0) {
    say.ok("decision keys are set for Jev and Clef");
  } else if (!interactive) {
    say.note(`not set: ${gaps.map((gap) => gap.label).join(", ")}`);
    say.note(
      "add them to ~/.config/devchestra/.env (see .env.example) or re-run this in a terminal",
    );
  } else {
    const entered = {};
    for (const gap of gaps) {
      const reply = await ask(`  Set up ${gap.label} for decision nodes now? [y/N] `);
      if (!/^y(es)?$/iu.test(reply)) continue;
      for (const name of gap.missing) {
        entered[name] = await ask(`    ${name}: `, { secret: true });
      }
    }
    const nextText = appendSecrets(currentText ?? null, entered);
    if (nextText !== (currentText ?? "")) {
      mkdirSync(targetDir, { recursive: true, mode: 0o700 });
      writeFileSync(targetPath, nextText, { mode: 0o600 });
      chmodSync(targetPath, 0o600);
      say.ok(`saved to ${targetPath} (mode 600)`);
    } else {
      say.note("skipped; add keys later to ~/.config/devchestra/.env (see .env.example)");
    }
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

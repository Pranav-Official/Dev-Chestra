#!/usr/bin/env node
// Package-manager-neutral workspace runner, so the root scripts behave the same under
// pnpm, npm and bun:
//   node scripts/workspaces.mjs run <script>                    every workspace that has <script>, dependencies first
//   node scripts/workspaces.mjs exec <package> -- <cmd> [args]  <cmd> inside one workspace package
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function workspaceDirs() {
  const patterns = readJson(join(root, "package.json")).workspaces ?? [];
  return patterns.flatMap((pattern) => {
    const base = pattern.replace(/\/\*$/u, "");
    return readdirSync(join(root, base), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, base, entry.name))
      .filter((dir) => existsSync(join(dir, "package.json")));
  });
}

function packages() {
  return workspaceDirs().map((dir) => ({ dir, manifest: readJson(join(dir, "package.json")) }));
}

function inDependencyOrder(all) {
  const names = new Set(all.map((pkg) => pkg.manifest.name));
  const done = new Set();
  const ordered = [];
  const visit = (pkg) => {
    if (done.has(pkg.manifest.name)) return;
    done.add(pkg.manifest.name);
    const deps = { ...pkg.manifest.dependencies, ...pkg.manifest.devDependencies };
    for (const name of Object.keys(deps).filter((dep) => names.has(dep))) {
      visit(all.find((candidate) => candidate.manifest.name === name));
    }
    ordered.push(pkg);
  };
  for (const pkg of all) visit(pkg);
  return ordered;
}

// Run through the package manager that started us (pnpm, npm or bun), falling back to npm.
function packageManager() {
  const agent = process.env.npm_config_user_agent ?? "";
  return /^(pnpm|bun|npm)\//u.exec(agent)?.[1] ?? "npm";
}

function spawnIn(dir, command, args) {
  const bins = [join(dir, "node_modules", ".bin"), join(root, "node_modules", ".bin")];
  const result = spawnSync(command, args, {
    cwd: dir,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, PATH: [...bins, process.env.PATH].join(delimiter) },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "run" && rest[0]) {
  const script = rest[0];
  const pm = packageManager();
  for (const pkg of inDependencyOrder(packages())) {
    if (!pkg.manifest.scripts?.[script]) continue;
    console.log(`\n> ${pkg.manifest.name}: ${script}`);
    spawnIn(pkg.dir, pm, ["run", script]);
  }
} else if (mode === "exec" && rest[0] && rest[1] === "--" && rest[2]) {
  const pkg = packages().find((candidate) => candidate.manifest.name === rest[0]);
  if (!pkg) {
    console.error(`No workspace package named ${rest[0]}`);
    process.exit(1);
  }
  spawnIn(pkg.dir, rest[2], rest.slice(3));
} else {
  console.error("usage: workspaces.mjs run <script> | exec <package> -- <command> [args]");
  process.exit(2);
}

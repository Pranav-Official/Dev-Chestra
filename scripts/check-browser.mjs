import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { build } from "esbuild";

const targets = [
  { name: "@relay/core", entry: "packages/core/src/index.ts" },
  { name: "@relay/schema", entry: "packages/schema/src/index.ts" },
  { name: "@relay/api", entry: "packages/api/src/index.ts" },
  { name: "@relay/web", entry: "apps/web/src/main.tsx", app: true },
];

const aliases = {
  "@relay/core": path.resolve("packages/core/src/index.ts"),
  "@relay/schema": path.resolve("packages/schema/src/index.ts"),
  "@relay/api": path.resolve("packages/api/src/index.ts"),
};

const alias = Object.fromEntries(
  Object.entries(aliases).filter(([, target]) => existsSync(target)),
);

let checked = 0;
let pending = 0;

for (const target of targets) {
  const entry = path.resolve(target.entry);
  if (!existsSync(entry)) {
    if (target.app) {
      pending += 1;
      console.log(`browser-safe bundle pending: ${target.name} has no ${target.entry} yet`);
    } else if (target.name === "@relay/api") {
      pending += 1;
      console.log(`browser-safe bundle pending: ${target.name} has no source entry yet`);
    }
    continue;
  }

  try {
    await build({
      entryPoints: [entry],
      absWorkingDir: process.cwd(),
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      outdir: path.resolve(".browser-check"),
      logLevel: "silent",
      alias,
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      loader: {
        ".ts": "ts",
        ".tsx": "tsx",
        ".css": "css",
        ".svg": "dataurl",
        ".png": "dataurl",
        ".jpg": "dataurl",
        ".woff": "dataurl",
        ".woff2": "dataurl",
      },
    });
    checked += 1;
    console.log(`browser-safe bundle ok: ${target.name} (${target.entry})`);
  } catch (error) {
    console.error(`browser-safe bundle FAILED: ${target.name} (${target.entry})`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (checked === 0 && pending === 0 && process.exitCode !== 1) {
  console.log("browser-safe bundle check: no browser entrypoints present yet");
}

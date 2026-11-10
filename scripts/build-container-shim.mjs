import { build } from "esbuild";

await build({
  entryPoints: ["src/bin/shim.ts"],
  outfile: "dist/bin/container-shim.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
});

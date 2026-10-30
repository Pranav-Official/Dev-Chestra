import { copyFileSync } from "node:fs";

copyFileSync(
  new URL("../packages/schema/src/node/worker.js", import.meta.url),
  new URL("../packages/schema/dist/node/worker.js", import.meta.url),
);

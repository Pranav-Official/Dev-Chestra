import { openStore } from "../dist/index.js";

const [file, runId] = process.argv.slice(2);
if (!file || !runId) {
  console.error("usage: child-append.mjs <db> <runId>");
  process.exit(2);
}

const store = openStore({ file });
process.stdout.write("ready\n");

let tick = 0;
for (;;) {
  store.events.append(runId, [
    {
      runId,
      path: "",
      type: "error.logged",
      actor: "system",
      payload: { code: "E_INTERNAL", message: `tick ${tick}` },
    },
  ]);
  tick += 1;
}

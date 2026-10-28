// Test worker that boots slowly, to prove cold start is not charged to the
// evaluation budget. It delays, then loads the real worker (which posts ready).
import { setTimeout as sleep } from "node:timers/promises";

await sleep(300);
await import("../../src/node/worker.js");

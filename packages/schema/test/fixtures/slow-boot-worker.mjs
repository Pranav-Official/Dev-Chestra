// Test worker that boots slowly, to prove cold start is not charged to the
// evaluation budget. It blocks for ~300ms (no imports: the schema package is
// browser-safe), then loads the real worker, which posts ready.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
await import("../../src/node/worker.js");

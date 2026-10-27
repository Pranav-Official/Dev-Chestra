import { z } from "zod";

/**
 * The browser app runs under a CSP without 'unsafe-eval'. Zod's JIT compiler
 * uses `new Function`, so every schema in this package is compiled jitless.
 * Import this module wherever `z` is used so the setting is applied before any
 * schema is constructed, even when @relay/schema is loaded on its own (for
 * example inside the editor's validation Web Worker).
 */
z.config({ jitless: true });

export { z };

import { type GateTestResult, gateTestRequestSchema, gateTestResultSchema } from "@relay/api";
import { evaluateGate } from "@relay/schema";
import { createNodeExpressionExecutor } from "@relay/schema/node";
import type { Context, Hono } from "hono";
import { errorBody } from "../errors.js";
import type { BrowserQueryPort } from "./ports.js";
import { readJsonObject } from "./security.js";

/** Whole-preview payload cap; scope itself is capped at 32 KiB by the DTO. */
const MAX_GATE_TEST_BODY_BYTES = 64 * 1024;
/** Canonical helper hard caps: 250 ms per branch, 2 s overall. */
const PER_BRANCH_TIMEOUT_MS = 250;
const GATE_TEST_TOTAL_TIMEOUT_MS = 2_000;

export interface GateRouteDeps {
  store: BrowserQueryPort;
  validate: (name: string, value: unknown) => void;
}

export function mountGateRoutes(app: Hono, deps: GateRouteDeps): void {
  app.post("/api/projects/:pid/gates/test", async (c) => {
    const project = await deps.store.getProject(c.req.param("pid"));
    if (project === null) {
      return c.json(errorBody("E_NOT_FOUND", "Project not found."), 404);
    }
    const raw = await readJsonObject(c, { maxBytes: MAX_GATE_TEST_BODY_BYTES });
    const parsed = gateTestRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        errorBody("E_VALIDATION", "Gate test body is invalid.", {
          issues: parsed.error.issues.slice(0, 5).map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        }),
        400,
      );
    }

    const evaluated = await evaluateGate(parsed.data.gate, parsed.data.scope, {
      executor: createNodeExpressionExecutor(),
      timeoutMs: PER_BRANCH_TIMEOUT_MS,
      overallTimeoutMs: GATE_TEST_TOTAL_TIMEOUT_MS,
    });
    if (!evaluated.ok) {
      return gateRequestError(c, evaluated.error);
    }
    const body: GateTestResult = evaluated.value;
    deps.validate("GateTestResult", body);
    return c.json(gateTestResultSchema.parse(body));
  });
}

function gateRequestError(c: Context, error: { code: string; message: string }): Response {
  return c.json(errorBody("E_VALIDATION", error.message), 400);
}

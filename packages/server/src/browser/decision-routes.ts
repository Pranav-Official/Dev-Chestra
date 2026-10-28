import {
  type DecisionProviderView,
  type DecisionTestRequest,
  type DecisionTestResult,
  decisionProvidersResponseSchema,
  decisionTestRequestSchema,
  decisionTestResultSchema,
  MAX_DECISION_TEST_STATE_BYTES,
} from "@relay/api";
import {
  createDecisionService,
  DECISION_PRESETS,
  type DecisionQuestion,
  type DecisionService,
  decisionProviders,
} from "@relay/decisions";
import { DECISION_PROVIDER_LABELS, type DecisionMode, routeDecision } from "@relay/schema";
import type { Hono } from "hono";
import { errorBody } from "../errors.js";
import type { BrowserQueryPort } from "./ports.js";
import { readJsonObject } from "./security.js";

/**
 * Decision tester body cap. The serialized `state` alone may be
 * MAX_DECISION_TEST_STATE_BYTES; this cap covers the envelope so the schema
 * reports state violations as E_VALIDATION instead of a bare 413.
 */
const MAX_DECISION_TEST_BODY_BYTES = MAX_DECISION_TEST_STATE_BYTES * 2;

export interface DecisionRouteDeps {
  store: BrowserQueryPort;
  decisions?: DecisionService;
  validate: (name: string, value: unknown) => void;
}

function questionFor(body: DecisionTestRequest): DecisionQuestion {
  const mode = body.mode;
  if (mode.kind === "boolean") {
    return { kind: "boolean", instructions: body.instructions };
  }
  if (mode.kind === "choice") {
    return {
      kind: "choice",
      instructions: body.instructions,
      options: mode.options.map((option) => ({
        value: option.value,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    };
  }
  return {
    kind: "score",
    instructions: body.instructions,
    levels: mode.levels.map((level) => ({
      label: level.label,
      ...(level.description === undefined ? {} : { description: level.description }),
    })),
  };
}

function routeModeFor(body: DecisionTestRequest): DecisionMode {
  const mode = body.mode;
  if (mode.kind === "boolean") {
    return {
      kind: "boolean",
      ...(mode.trueAt === undefined ? {} : { trueAt: mode.trueAt }),
      ...(mode.falseAt === undefined ? {} : { falseAt: mode.falseAt }),
    };
  }
  if (mode.kind === "choice") {
    return {
      kind: "choice",
      options: mode.options.map((option) => ({
        value: option.value,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
      branches: mode.branches.map((branch) => ({ id: branch.id, values: [...branch.values] })),
      ...(mode.minConfidence === undefined ? {} : { minConfidence: mode.minConfidence }),
    };
  }
  return {
    kind: "score",
    levels: mode.levels.map((level) => ({
      label: level.label,
      ...(level.description === undefined ? {} : { description: level.description }),
    })),
    bands: mode.bands.map((band) => ({ id: band.id, atLeast: band.atLeast })),
    ...(mode.minConfidence === undefined ? {} : { minConfidence: mode.minConfidence }),
  };
}

export function mountDecisionRoutes(app: Hono, deps: DecisionRouteDeps): void {
  const service = deps.decisions ?? createDecisionService();

  app.get("/api/decision-providers", (c) => {
    const body: DecisionProviderView[] = decisionProviders().map((id) => {
      const availability = service.client(id).availability();
      return {
        id,
        label: DECISION_PROVIDER_LABELS[id],
        ready: availability.ready,
        // Secret NAMES only; values never leave the decisions package.
        missing: availability.missing,
      };
    });
    deps.validate("DecisionProvidersResponse", body);
    return c.json(decisionProvidersResponseSchema.parse(body));
  });

  app.post("/api/projects/:pid/decisions/test", async (c) => {
    const project = await deps.store.getProject(c.req.param("pid"));
    if (project === null) {
      return c.json(errorBody("E_NOT_FOUND", "Project not found."), 404);
    }
    let raw: Record<string, unknown>;
    try {
      raw = await readJsonObject(c, { maxBytes: MAX_DECISION_TEST_BODY_BYTES });
    } catch (error) {
      if (error instanceof Error && (error as { code?: unknown }).code === "E_PAYLOAD_TOO_LARGE") {
        return c.json(errorBody("E_PAYLOAD_TOO_LARGE", "Request body is too large."), 413);
      }
      throw error;
    }
    const parsed = decisionTestRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        errorBody("E_VALIDATION", "Decision test body is invalid.", {
          issues: parsed.error.issues.slice(0, 5).map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        }),
        400,
      );
    }
    const body = parsed.data;
    const preset = DECISION_PRESETS[body.provider];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), preset.timeoutMs);
    try {
      const result = await service.client(body.provider).ask(
        {
          provider: body.provider,
          ...(body.model === undefined ? {} : { model: body.model }),
          state: body.state,
          question: questionFor(body),
        },
        controller.signal,
      );
      if (!result.ok) {
        // The client redacts key material; only the safe message reaches the wire.
        return c.json(errorBody("E_INTERNAL", result.error.message), 502);
      }
      const response: DecisionTestResult = {
        output: result.value.output,
        routing: routeDecision(routeModeFor(body), result.value.output),
        latencyMs: result.value.latencyMs,
        ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
      };
      deps.validate("DecisionTestResult", response);
      return c.json(decisionTestResultSchema.parse(response));
    } finally {
      clearTimeout(timer);
    }
  });
}

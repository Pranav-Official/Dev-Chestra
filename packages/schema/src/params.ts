import type {
  Issue,
  NormalizedStartNode,
  ParamValidation,
  StartNode,
  WorkflowFile,
  WorkflowParam,
} from "./types.js";

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export type ParamSource =
  | WorkflowFile
  | StartNode
  | NormalizedStartNode
  | { params: readonly WorkflowParam[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function error(code: string, message: string, pointer?: string): Issue {
  return {
    severity: "error",
    code,
    message,
    ...(pointer === undefined ? {} : { pointer }),
  };
}

export function validateParamDefinitions(
  params: readonly WorkflowParam[],
  pointerBase: string,
  nodeId?: string,
): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  params.forEach((param, index) => {
    const pointer = `${pointerBase}/${index}`;
    const add = (code: string, message: string): void => {
      issues.push({
        ...error(code, message, pointer),
        ...(nodeId === undefined ? {} : { nodeId }),
      });
    };

    if (typeof param.name !== "string" || !PARAM_NAME.test(param.name)) {
      add(
        "E_PARAM_NAME",
        `Parameter name '${String(param.name)}' must match ${PARAM_NAME.source} (JSONata-safe, no hyphens).`,
      );
    } else if (seen.has(param.name)) {
      add("E_PARAM_DUPLICATE", `Duplicate parameter name '${param.name}'.`);
    } else {
      seen.add(param.name);
    }

    if (!["string", "number", "boolean", "enum"].includes(param.type)) {
      add(
        "E_PARAM_TYPE",
        `Parameter '${param.name}' has unsupported type '${String(param.type)}'.`,
      );
      return;
    }
    if (typeof param.required !== "boolean") {
      add("E_PARAM_TYPE", `Parameter '${param.name}' must declare required: true|false.`);
    }

    if (param.type === "enum") {
      if (!Array.isArray(param.options) || param.options.length === 0) {
        add("E_PARAM_OPTIONS", `Enum parameter '${param.name}' needs a non-empty options array.`);
      } else {
        const unique = new Set<string>();
        for (const option of param.options) {
          if (typeof option !== "string" || option === "") {
            add(
              "E_PARAM_OPTIONS",
              `Enum parameter '${param.name}' options must be non-empty strings.`,
            );
          } else if (unique.has(option)) {
            add(
              "E_PARAM_OPTIONS",
              `Enum parameter '${param.name}' has duplicate option '${option}'.`,
            );
          }
          unique.add(option);
        }
        if (
          param.default !== undefined &&
          typeof param.default === "string" &&
          !unique.has(param.default)
        ) {
          add(
            "E_PARAM_DEFAULT",
            `Default for enum parameter '${param.name}' is not one of its options.`,
          );
        }
      }
    } else if (param.options !== undefined) {
      add("E_PARAM_OPTIONS", `Only enum parameters may declare options ('${param.name}').`);
    }

    if (param.default !== undefined) {
      const expected = param.type;
      if (expected === "string" && typeof param.default !== "string") {
        add("E_PARAM_DEFAULT", `Default for '${param.name}' must be a string.`);
      } else if (expected === "boolean" && typeof param.default !== "boolean") {
        add("E_PARAM_DEFAULT", `Default for '${param.name}' must be a boolean.`);
      } else if (
        expected === "number" &&
        (typeof param.default !== "number" || !Number.isFinite(param.default))
      ) {
        add("E_PARAM_DEFAULT", `Default for '${param.name}' must be a finite number.`);
      } else if (expected === "enum" && typeof param.default !== "string") {
        add("E_PARAM_DEFAULT", `Default for '${param.name}' must be an enum option string.`);
      }
    }
  });
  return issues;
}

function paramsOf(source: ParamSource): readonly WorkflowParam[] | undefined {
  if ("params" in source) return source.params;
  const start = source.graph.nodes.find((node) => node.type === "start");
  return start?.type === "start" ? start.params : undefined;
}

/**
 * Validate and resolve run parameters against the start node. Unknown fields,
 * missing required values and wrong types are errors. Defaults are applied.
 * Invalid definitions are reported too, so this is safe to call before a run.
 */
export function validateParams(source: ParamSource, input?: unknown): ParamValidation {
  const params = paramsOf(source);
  if (params === undefined) {
    return {
      ok: false,
      value: {},
      errors: [error("E_PARAM_START", "Workflow has no start node parameters to resolve.")],
    };
  }

  const errors = validateParamDefinitions(params, "/graph/nodes", undefined);
  let raw: Record<string, unknown> = {};
  if (input !== undefined) {
    if (!isRecord(input)) {
      errors.push(error("E_PARAM_TYPE", "Run parameters must be a JSON object."));
    } else {
      raw = input;
    }
  }

  const known = new Set(params.map((param) => param.name));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      errors.push(error("E_PARAM_UNKNOWN", `Unknown run parameter '${key}'.`));
    }
  }

  const value: Record<string, unknown> = {};
  for (const param of params) {
    if (typeof param.name !== "string" || !PARAM_NAME.test(param.name)) continue;
    const provided = Object.hasOwn(raw, param.name);
    let resolved: unknown;
    if (provided) {
      resolved = raw[param.name];
    } else if (param.default !== undefined) {
      resolved = param.default;
    } else if (param.required) {
      errors.push(error("E_PARAM_MISSING", `Required parameter '${param.name}' is missing.`));
      continue;
    } else {
      continue;
    }

    if (param.type === "string" && typeof resolved !== "string") {
      errors.push(error("E_PARAM_TYPE", `Parameter '${param.name}' must be a string.`));
      continue;
    }
    if (param.type === "number" && (typeof resolved !== "number" || !Number.isFinite(resolved))) {
      errors.push(error("E_PARAM_TYPE", `Parameter '${param.name}' must be a finite number.`));
      continue;
    }
    if (param.type === "boolean" && typeof resolved !== "boolean") {
      errors.push(error("E_PARAM_TYPE", `Parameter '${param.name}' must be a boolean.`));
      continue;
    }
    if (param.type === "enum") {
      const options = param.options ?? [];
      if (typeof resolved !== "string") {
        errors.push(
          error("E_PARAM_TYPE", `Parameter '${param.name}' must be an enum option string.`),
        );
        continue;
      }
      if (!options.includes(resolved)) {
        errors.push(
          error("E_PARAM_ENUM", `Parameter '${param.name}' must be one of: ${options.join(", ")}.`),
        );
        continue;
      }
    }
    value[param.name] = resolved;
  }

  return { ok: errors.length === 0, value, errors };
}

/** Alias used by the engine: same behavior as validateParams. */
export function resolveParams(source: ParamSource, input?: unknown): ParamValidation {
  return validateParams(source, input);
}

/**
 * The only headers a webhook mapping may read. Authorization, cookies,
 * signatures and other credential-bearing headers are never exposed.
 */
export const WEBHOOK_HEADER_ALLOWLIST: readonly string[] = [
  "content-type",
  "user-agent",
  "x-github-delivery",
  "x-github-event",
  "x-gitlab-event",
  "x-webhook-id",
];

const WEBHOOK_PATH_MAX = 256;
const WEBHOOK_BODY_DEPTH_MAX = 8;
const WEBHOOK_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const WEBHOOK_INDEX = /^\d{1,6}$/;
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export type WebhookPath =
  | { source: "body"; segments: readonly string[] }
  | { source: "headers"; name: string };

/**
 * Parses `body.<key>[.<key|index>]...` or `headers.<allowlisted-name>`.
 * Returns null for anything else, including unsafe object keys.
 */
export function parseWebhookPath(path: string): WebhookPath | null {
  if (path.length === 0 || path.length > WEBHOOK_PATH_MAX) return null;
  const [root, ...segments] = path.split(".");
  if (root === "headers") {
    const name = segments.length === 1 ? segments[0] : undefined;
    if (name === undefined || !WEBHOOK_HEADER_ALLOWLIST.includes(name)) return null;
    return { source: "headers", name };
  }
  if (root !== "body" || segments.length === 0 || segments.length > WEBHOOK_BODY_DEPTH_MAX) {
    return null;
  }
  for (const segment of segments) {
    if (!WEBHOOK_SEGMENT.test(segment) || UNSAFE_PATH_SEGMENTS.has(segment)) return null;
  }
  return { source: "body", segments };
}

/** Structural checks for a start node's webhook block. Reports in saved-file terms. */
export function validateWebhookConfig(
  start: {
    id?: string;
    params: readonly WorkflowParam[];
    webhook?: { paramMapping?: Record<string, string> };
  },
  pointerBase: string,
): Issue[] {
  const mapping = start.webhook?.paramMapping;
  if (mapping === undefined) return [];
  const declared = new Set(start.params.map((param) => param.name));
  const issues: Issue[] = [];
  for (const [name, path] of Object.entries(mapping)) {
    const pointer = `${pointerBase}/paramMapping/${name}`;
    const nodeId = start.id;
    const add = (code: string, message: string): void => {
      issues.push({
        ...error(code, message, pointer),
        ...(nodeId === undefined ? {} : { nodeId }),
      });
    };
    if (!declared.has(name)) {
      add("E_WEBHOOK_MAPPING", `Webhook mapping targets undeclared parameter '${name}'.`);
      continue;
    }
    const parsed = parseWebhookPath(path);
    if (parsed === null) {
      add(
        "E_WEBHOOK_PATH",
        `Webhook mapping for '${name}' must be body.<path> (up to ${WEBHOOK_BODY_DEPTH_MAX} segments) or headers.<allowlisted name>.`,
      );
    }
  }
  return issues;
}

/**
 * Reads one webhook delivery into run parameters, then applies the same
 * validation as a manual run. Only allowlisted headers are read. Null and
 * missing values count as absent, so defaults and required checks still apply.
 */
export function resolveWebhookParams(
  start: StartNode | NormalizedStartNode,
  delivery: { body: unknown; headers: Readonly<Record<string, string | undefined>> },
): ParamValidation {
  const mapping = start.webhook?.paramMapping;
  const raw: Record<string, unknown> = {};
  for (const param of start.params) {
    const path = mapping?.[param.name];
    const value =
      mapping === undefined
        ? bodyKey(delivery.body, param.name)
        : path === undefined
          ? undefined
          : readWebhookPath(delivery, path);
    if (value !== undefined && value !== null) raw[param.name] = value;
  }
  return validateParams(start, raw);
}

function bodyKey(body: unknown, key: string): unknown {
  return isRecord(body) && Object.hasOwn(body, key) ? body[key] : undefined;
}

function readWebhookPath(
  delivery: { body: unknown; headers: Readonly<Record<string, string | undefined>> },
  path: string,
): unknown {
  const parsed = parseWebhookPath(path);
  if (parsed === null) return undefined;
  if (parsed.source === "headers") return delivery.headers[parsed.name];
  let current: unknown = delivery.body;
  for (const segment of parsed.segments) {
    if (Array.isArray(current)) {
      if (!WEBHOOK_INDEX.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isRecord(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

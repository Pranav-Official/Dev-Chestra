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

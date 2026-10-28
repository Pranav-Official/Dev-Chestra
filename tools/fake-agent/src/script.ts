import { MAX_INPUT_PATH_SEGMENTS } from "./input.js";
import type { FakeStep } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(index: number, message: string): never {
  throw new Error(`Invalid fake script step ${index}: ${message}`);
}

/** Parse and validate the documented JSON script. */
export function parseFakeScript(raw: string): FakeStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Fake script must be valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Fake script must be a JSON array of steps.");
  }

  return parsed.map((value: unknown, index: number): FakeStep => {
    if (!isRecord(value)) {
      fail(index, "step must be an object");
    }
    const type = value.type;
    switch (type) {
      case "say": {
        if (typeof value.text !== "string") {
          fail(index, "say.text must be a string");
        }
        return { type, text: value.text };
      }
      case "tool": {
        if (typeof value.name !== "string" || value.name === "") {
          fail(index, "tool.name must be a non-empty string");
        }
        const rawArgs = value.args ?? value.arguments ?? {};
        if (!isRecord(rawArgs)) {
          fail(index, "tool.args must be an object");
        }
        return { type, name: value.name, args: rawArgs };
      }
      case "submit": {
        if (!Object.hasOwn(value, "output") || !isRecord(value.output)) {
          fail(index, "submit.output must be an object (it is passed as submit_result arguments)");
        }
        return { type, output: value.output };
      }
      case "submit-from-inputs": {
        if (!Array.isArray(value.path)) {
          fail(index, "submit-from-inputs.path must be an array of string segments");
        }
        if (value.path.length === 0 || value.path.length > MAX_INPUT_PATH_SEGMENTS) {
          fail(index, `submit-from-inputs.path must contain 1-${MAX_INPUT_PATH_SEGMENTS} segments`);
        }
        const path: string[] = [];
        for (const segment of value.path) {
          if (typeof segment !== "string" || segment === "") {
            fail(index, "submit-from-inputs.path segments must be non-empty strings");
          }
          path.push(segment);
        }
        if (!Object.hasOwn(value, "fallback") || !isRecord(value.fallback)) {
          fail(index, "submit-from-inputs.fallback must be an object");
        }
        return { type, path, fallback: value.fallback };
      }
      case "sleep": {
        if (typeof value.ms !== "number" || !Number.isSafeInteger(value.ms) || value.ms < 0) {
          fail(index, "sleep.ms must be a non-negative integer");
        }
        return { type, ms: value.ms };
      }
      case "crash": {
        if (
          typeof value.code !== "number" ||
          !Number.isSafeInteger(value.code) ||
          value.code < 0 ||
          value.code > 255
        ) {
          fail(index, "crash.code must be an integer from 0 to 255");
        }
        return { type, code: value.code };
      }
      default:
        return fail(index, `unknown step type ${JSON.stringify(type)}`);
    }
  });
}

import { DevChestraError, type ErrorCode } from "@devchestra/core";

export function fail(code: ErrorCode, message: string, details?: unknown): never {
  throw new DevChestraError(code, message, details === undefined ? {} : { details });
}

export function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new DevChestraError("E_INTERNAL", "Stored JSON is corrupt", { cause: error });
  }
}

export function nodeIdFromPath(path: string): string {
  const last = path.split("/").pop() ?? path;
  const cut = last.search(/[[#]/);
  return cut === -1 ? last : last.slice(0, cut);
}

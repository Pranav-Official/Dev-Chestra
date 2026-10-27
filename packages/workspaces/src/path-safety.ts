import * as fs from "node:fs";
import * as path from "node:path";
import { err, ok, RelayError, type Result } from "@relay/core";

const forbidden = (message: string, details?: unknown): RelayError =>
  new RelayError("E_FORBIDDEN_PATH", message, details === undefined ? {} : { details });
const missing = (error: unknown): boolean =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");
const traversal = (rel: string): boolean =>
  rel.split(/[\\/]+/u).some((segment) => segment === "..");
function within(rootReal: string, candidate: string): boolean {
  const rel = path.relative(rootReal, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function longestExisting(candidate: string): string {
  let probe = candidate;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(probe);
      if (suffix.length > 0 && !fs.statSync(probe).isDirectory()) {
        throw forbidden("Path traverses a non-directory", { path: probe });
      }
      return suffix.length === 0 ? real : path.join(real, ...suffix.slice().reverse());
    } catch (error) {
      if (!missing(error)) {
        throw error instanceof RelayError
          ? error
          : forbidden("Path cannot be canonicalized", { path: probe, cause: error });
      }
      const parent = path.dirname(probe);
      if (parent === probe) throw forbidden("Path has no existing ancestor", { path: candidate });
      suffix.push(path.basename(probe));
      probe = parent;
    }
  }
}
function checkRel(rel: string): RelayError | null {
  if (typeof rel !== "string") return forbidden("Relative path must be a string");
  if (rel.includes("\0")) return forbidden("Relative path must not contain NUL");
  if (path.isAbsolute(rel)) return forbidden("Relative path must not be absolute");
  if (traversal(rel)) return forbidden("Relative path must not contain '..'");
  return null;
}
const roots = new Map<string, string>();
export function realRoot(root: string): string {
  if (typeof root !== "string" || root.length === 0 || root.includes("\0")) {
    throw forbidden("Root must be a non-empty path without NUL");
  }
  if (!path.isAbsolute(root)) throw forbidden("Root must be absolute", { root });
  const key = path.resolve(root);
  const cached = roots.get(key);
  if (cached !== undefined) return cached;
  const real = fs.realpathSync.native(key);
  if (!fs.statSync(real).isDirectory()) throw forbidden("Root is not a directory", { root });
  roots.set(key, real);
  return real;
}
export function isInside(root: string, candidate: string): boolean {
  try {
    if (typeof candidate !== "string" || candidate.includes("\0")) return false;
    if (!path.isAbsolute(candidate)) return false;
    return within(realRoot(root), longestExisting(path.resolve(candidate)));
  } catch {
    return false;
  }
}
export function resolveInside(root: string, rel: string): Result<string, RelayError> {
  const invalid = checkRel(rel);
  if (invalid !== null) return err(invalid);
  try {
    const rootReal = realRoot(root);
    const resolved = longestExisting(path.resolve(rootReal, rel));
    return within(rootReal, resolved)
      ? ok(resolved)
      : err(forbidden("Path escapes the allowed root", { root: rootReal, path: resolved }));
  } catch (error) {
    return err(
      error instanceof RelayError
        ? error
        : forbidden("Path resolution failed", { root, rel, cause: error }),
    );
  }
}
export function resolveFileInside(root: string, rel: string): Result<string, RelayError> {
  const invalid = checkRel(rel);
  if (invalid !== null) return err(invalid);
  try {
    const rootReal = realRoot(root);
    const candidate = path.resolve(rootReal, rel);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) return err(forbidden("Final path component is a symlink"));
    if (!stat.isFile()) return err(forbidden("Final path component is not a regular file"));
    const resolved = longestExisting(candidate);
    return within(rootReal, resolved)
      ? ok(resolved)
      : err(forbidden("Path escapes the allowed root", { root: rootReal, path: resolved }));
  } catch (error) {
    if (missing(error)) {
      return err(new RelayError("E_NOT_FOUND", `File not found: ${rel}`, { details: { rel } }));
    }
    return err(
      error instanceof RelayError
        ? error
        : forbidden("File resolution failed", { root, rel, cause: error }),
    );
  }
}
export class PathSafety {
  readonly realRoot = realRoot;
  readonly isInside = isInside;
  readonly resolveInside = resolveInside;
  readonly resolveFileInside = resolveFileInside;
}
export const pathSafety = new PathSafety();

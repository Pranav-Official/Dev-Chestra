import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isInside, pathSafety, realRoot, resolveFileInside, resolveInside } from "../src/index.js";
import { cleanup, expectError, tempDir, unwrap } from "./helpers.js";

afterEach(cleanup);

describe("PathSafety.resolveInside", () => {
  it("resolves existing and missing prefixes under the real root", () => {
    const root = tempDir();
    mkdirSync(join(root, "a", "b"), { recursive: true });
    const real = realRoot(root);
    expect(unwrap(resolveInside(root, ""))).toBe(real);
    expect(unwrap(resolveInside(root, "a/b/new.txt"))).toBe(join(real, "a/b/new.txt"));
    expect(unwrap(resolveInside(root, "missing/deeper"))).toBe(join(real, "missing/deeper"));
  });

  it("rejects absolute, NUL and traversal inputs", () => {
    const root = tempDir();
    for (const rel of [
      "/etc/passwd",
      "..",
      "../outside",
      "a/../../outside",
      "a/..",
      "..\\outside",
      "a\0b",
    ]) {
      expect(expectError(resolveInside(root, rel)).code, rel).toBe("E_FORBIDDEN_PATH");
    }
  });

  it("treats percent-like names as literal names, not traversal", () => {
    const root = tempDir();
    const real = realRoot(root);
    const rel = "%2e%2e/%2e%2e/etc/passwd";
    const resolved = unwrap(resolveInside(root, rel));
    expect(resolved).toBe(join(real, rel));
    expect(isInside(root, resolved)).toBe(true);
  });

  it("uses boundary-aware containment, not string prefixes", () => {
    const root = tempDir();
    const sibling = `${root}-sibling`;
    mkdirSync(sibling);
    expect(isInside(root, sibling)).toBe(false);
    expect(isInside(root, join(root, "missing"))).toBe(true);
    expect(isInside(root, join(root, "a"))).toBe(true);
    expect(isInside(root, join(root, "..", "outside"))).toBe(false);
  });

  it("does not treat a case-different sibling as inside on a case-sensitive tree", () => {
    const base = tempDir();
    const root = join(base, "root");
    const sibling = join(base, "ROOT");
    mkdirSync(root);
    mkdirSync(sibling);
    if (realpathSync(sibling) !== realpathSync(root)) {
      expect(isInside(root, sibling)).toBe(false);
      expect(isInside(root, join(base, "Root"))).toBe(false);
    }
  });

  it("rejects symlink escapes and accepts symlinks that stay inside", () => {
    const root = tempDir();
    const outside = tempDir();
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "link"));
    symlinkSync(join(root, "a"), join(root, "inside-link"));

    expect(expectError(resolveInside(root, "link/secret.txt")).code).toBe("E_FORBIDDEN_PATH");
    expect(expectError(resolveInside(root, "link")).code).toBe("E_FORBIDDEN_PATH");
    expect(unwrap(resolveInside(root, "inside-link/b"))).toBe(join(realRoot(root), "a/b"));
  });

  it("exposes the same behavior through the singleton", () => {
    const root = tempDir();
    const singleton: typeof pathSafety = pathSafety;
    expect(unwrap(singleton.resolveInside(root, "x"))).toBe(join(realRoot(root), "x"));
    expect(singleton.isInside(root, join(root, "x"))).toBe(true);
  });
});

describe("PathSafety.resolveFileInside", () => {
  it("returns regular files and rejects symlinks, directories and traversal", () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(root, "file.txt"), "ok");
    writeFileSync(join(outside, "secret.txt"), "secret");
    mkdirSync(join(root, "dir"));
    symlinkSync(join(root, "file.txt"), join(root, "file-link.txt"));
    symlinkSync(outside, join(root, "outside-link"));

    expect(unwrap(resolveFileInside(root, "file.txt"))).toBe(join(realRoot(root), "file.txt"));
    expect(expectError(resolveFileInside(root, "file-link.txt")).code).toBe("E_FORBIDDEN_PATH");
    expect(expectError(resolveFileInside(root, "outside-link/secret.txt")).code).toBe(
      "E_FORBIDDEN_PATH",
    );
    expect(expectError(resolveFileInside(root, "dir")).code).toBe("E_FORBIDDEN_PATH");
    expect(expectError(resolveFileInside(root, "missing.txt")).code).toBe("E_NOT_FOUND");
    expect(expectError(resolveFileInside(root, "../file.txt")).code).toBe("E_FORBIDDEN_PATH");
  });
});

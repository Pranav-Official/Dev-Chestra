import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DevChestraError,
  formatPath,
  fsSlug,
  isUnder,
  type NodeId,
  type Path,
  parent,
  parsePath,
  type Segment,
} from "../src/index.js";

const asPath = (value: string): Path => value as Path;

describe("execution path grammar", () => {
  it("parses the run-level path and ordinary paths", () => {
    expect(parsePath("")).toEqual({ ok: true, value: [] });
    expect(parsePath("research")).toEqual({
      ok: true,
      value: [{ node: "research" }],
    });
    expect(parsePath("evaluate[3]/try")).toEqual({
      ok: true,
      value: [{ node: "evaluate", index: 3 }, { node: "try" }],
    });
    expect(parsePath("refine#2/critic")).toEqual({
      ok: true,
      value: [{ node: "refine", round: 2 }, { node: "critic" }],
    });
    expect(parsePath("supervisor")).toEqual({ ok: true, value: [{ node: "supervisor" }] });
  });

  it("rejects malformed or non-canonical paths", () => {
    const invalid = [
      "/a",
      "a/",
      "a//b",
      "A",
      "1a",
      "_a",
      "a b",
      "a[",
      "a[]",
      "a[01]",
      "a[-1]",
      "a[1.5]",
      "a[1]#2",
      "a#0",
      "a#01",
      "a#-1",
      "a[1]x",
      "é",
      "a[999999999999999999999999]",
      "a".repeat(49),
    ];
    for (const value of invalid) {
      const result = parsePath(value);
      expect(result.ok, value).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(DevChestraError);
    }
  });

  it("formats and parses branded segments for parent and child paths", () => {
    const child = formatPath([{ node: "evaluate" as NodeId, index: 3 }, { node: "try" as NodeId }]);
    expect(child).toBe("evaluate[3]/try");
    expect(parent(child)).toBe("evaluate[3]");
    expect(parent(formatPath([{ node: "a" as NodeId }]))).toBe("");
    expect(parent(asPath(""))).toBe("");
  });

  it("rejects invalid segments when formatting", () => {
    expect(() => formatPath([{ node: "Bad" as NodeId }])).toThrow(DevChestraError);
    expect(() => formatPath([{ node: "a" as NodeId, index: -1 }])).toThrow(DevChestraError);
    expect(() => formatPath([{ node: "a" as NodeId, round: 0 }])).toThrow(DevChestraError);
    expect(() => formatPath([{ node: "a" as NodeId, index: 1, round: 1 }])).toThrow(
      DevChestraError,
    );
  });

  it("compares prefixes segment-wise, never by raw string prefix", () => {
    expect(isUnder(asPath("a"), asPath("a"))).toBe(true);
    expect(isUnder(asPath("a"), asPath("a/b"))).toBe(true);
    expect(isUnder(asPath("a[1]"), asPath("a[1]/b"))).toBe(true);
    expect(isUnder(asPath("a[1]"), asPath("a[10]/b"))).toBe(false);
    expect(isUnder(asPath("a"), asPath("ab"))).toBe(false);
    expect(isUnder(asPath("a/b"), asPath("a"))).toBe(false);
    expect(isUnder(asPath("a"), asPath("a#1"))).toBe(false);
    expect(isUnder(asPath(""), asPath("anything"))).toBe(true);
  });
});

describe("filesystem slugs", () => {
  it("uses collision-free structural markers", () => {
    expect(fsSlug(asPath("refine#2/critic"))).toBe("refine+r2++critic");
    expect(fsSlug(asPath("evaluate[3]/try"))).toBe("evaluate+i3++try");
    expect(fsSlug(asPath(""))).toBe("");
    expect(fsSlug(asPath("con"))).toBe("_con");
    expect(fsSlug(asPath("con[0]"))).toBe("con+i0");
  });

  it("fixes the draft's known collisions", () => {
    const cases: [string, string][] = [
      ["x[1]", "x-1"],
      ["x#1", "x-r1"],
      ["a/b", "a__b"],
      ["a[1]/b", "a-1__b"],
      ["a_r1", "a/r1"],
      ["refine#2/critic", "refine-r2__critic"],
    ];
    for (const [left, right] of cases) {
      expect(left, `${left} and ${right} must be different paths`).not.toBe(right);
      expect(fsSlug(asPath(left))).not.toBe(fsSlug(asPath(right)));
    }
  });

  it("is injective over generated distinct paths", () => {
    const nodeArb = fc.stringMatching(/^[a-z][a-z0-9_-]{0,47}$/).map((node) => node as NodeId);
    const segmentArb: fc.Arbitrary<Segment> = fc.oneof(
      nodeArb.map((node): Segment => ({ node })),
      fc
        .tuple(nodeArb, fc.integer({ min: 0, max: 10_000 }))
        .map(([node, index]): Segment => ({ node, index })),
      fc
        .tuple(nodeArb, fc.integer({ min: 1, max: 10_000 }))
        .map(([node, round]): Segment => ({ node, round })),
    );
    const pathArb = fc.array(segmentArb, { maxLength: 6 }).map((segments) => formatPath(segments));

    fc.assert(
      fc.property(fc.array(pathArb, { maxLength: 25 }), (paths) => {
        const unique = [...new Set(paths.map((path) => path as string))];
        const slugs = new Set(unique.map((path) => fsSlug(path as Path)));
        return slugs.size === unique.length;
      }),
      { numRuns: 200 },
    );
  });

  it("round-trips generated canonical paths", () => {
    const nodeArb = fc.stringMatching(/^[a-z][a-z0-9_-]{0,47}$/).map((node) => node as NodeId);
    const segmentArb: fc.Arbitrary<Segment> = fc.oneof(
      nodeArb.map((node): Segment => ({ node })),
      fc
        .tuple(nodeArb, fc.integer({ min: 0, max: 10_000 }))
        .map(([node, index]): Segment => ({ node, index })),
      fc
        .tuple(nodeArb, fc.integer({ min: 1, max: 10_000 }))
        .map(([node, round]): Segment => ({ node, round })),
    );

    fc.assert(
      fc.property(fc.array(segmentArb, { maxLength: 6 }), (segments) => {
        const parsed = parsePath(formatPath(segments));
        return parsed.ok && JSON.stringify(parsed.value) === JSON.stringify(segments);
      }),
      { numRuns: 200 },
    );
  });
});

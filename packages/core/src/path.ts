import { RelayError } from "./error.js";
import type { Brand, NodeId } from "./ids.js";
import type { Result } from "./result.js";
import { err, ok } from "./result.js";

export type Path = Brand<string, "Path">;

export interface Segment {
  node: NodeId;
  index?: number;
  round?: number;
}

const NODE_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const SEGMENT_RE = /^([a-z][a-z0-9_-]{0,47})(?:\[(0|[1-9][0-9]*)\]|#([1-9][0-9]*))?$/;
const RESERVED_FS_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export const RUN_PATH = "" as Path;
export const SUPERVISOR_PATH = "supervisor" as Path;

function validation(message: string): RelayError {
  return new RelayError("E_VALIDATION", message);
}

function isNodeId(node: string): node is NodeId {
  return NODE_RE.test(node);
}

function safeNonNegativeInt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function parsePath(input: string): Result<Segment[], RelayError> {
  if (input === "") return ok([]);
  if (input.startsWith("/") || input.endsWith("/")) {
    return err(validation(`Path cannot start or end with '/': ${input}`));
  }
  const pieces = input.split("/");
  const segments: Segment[] = [];
  for (const piece of pieces) {
    if (piece === "") return err(validation(`Path contains an empty segment: ${input}`));
    const match = SEGMENT_RE.exec(piece);
    if (match === null) return err(validation(`Invalid path segment '${piece}' in '${input}'`));
    const node = match[1];
    if (node === undefined || !isNodeId(node)) {
      return err(validation(`Invalid node id in segment '${piece}'`));
    }
    const indexText = match[2];
    const roundText = match[3];
    if (indexText !== undefined) {
      const index = Number(indexText);
      if (!safeNonNegativeInt(index)) {
        return err(validation(`Map index is not a safe integer in segment '${piece}'`));
      }
      segments.push({ node, index });
    } else if (roundText !== undefined) {
      const round = Number(roundText);
      if (!safeNonNegativeInt(round) || round < 1) {
        return err(validation(`Loop round is not a positive safe integer in segment '${piece}'`));
      }
      segments.push({ node, round });
    } else {
      segments.push({ node });
    }
  }
  return ok(segments);
}

function formatSegment(segment: Segment): string {
  if (!isNodeId(segment.node)) {
    throw validation(`Invalid node id: ${String(segment.node)}`);
  }
  if (segment.index !== undefined && segment.round !== undefined) {
    throw validation(`Segment '${segment.node}' cannot have both an index and a round`);
  }
  if (segment.index !== undefined) {
    if (!safeNonNegativeInt(segment.index)) {
      throw validation(`Invalid map index for '${segment.node}': ${String(segment.index)}`);
    }
    return `${segment.node}[${segment.index}]`;
  }
  if (segment.round !== undefined) {
    if (!safeNonNegativeInt(segment.round) || segment.round < 1) {
      throw validation(`Invalid loop round for '${segment.node}': ${String(segment.round)}`);
    }
    return `${segment.node}#${segment.round}`;
  }
  return segment.node;
}

export function formatPath(segments: readonly Segment[]): Path {
  return segments.map(formatSegment).join("/") as Path;
}

function segmentsOf(path: Path | string): Segment[] {
  const parsed = parsePath(path);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

export function parent(path: Path | string): Path {
  return formatPath(segmentsOf(path).slice(0, -1));
}

function sameSegment(left: Segment, right: Segment): boolean {
  return left.node === right.node && left.index === right.index && left.round === right.round;
}

export function isUnder(prefix: Path | string, path: Path | string): boolean {
  const left = segmentsOf(prefix);
  const right = segmentsOf(path);
  if (left.length > right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (a === undefined || b === undefined || !sameSegment(a, b)) return false;
  }
  return true;
}

/**
 * Collision-free filesystem slug.
 *
 * The draft encoding (`[i]` -> `-i`, `#n` -> `-r<n>`, `/` -> `__`) is not
 * injective because node ids may already contain `-` and `_`:
 *   x[1] == x-1, x#1 == x-r1, a/b == a__b.
 *
 * Structural markers therefore use `+`, which cannot occur in a NodeId:
 *   [i] -> +i<i>, #n -> +r<n>, / -> ++
 * Node text is copied unchanged. Since `+` is absent from node ids, no node
 * text can be mistaken for a marker or separator.
 */
export function fsSlug(path: Path | string): string {
  const segments = segmentsOf(path);
  const slug = segments
    .map((segment) => {
      if (segment.index !== undefined) return `${segment.node}+i${segment.index}`;
      if (segment.round !== undefined) return `${segment.node}+r${segment.round}`;
      return segment.node;
    })
    .join("++");
  return RESERVED_FS_RE.test(slug) ? `_${slug}` : slug;
}

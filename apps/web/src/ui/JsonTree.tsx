import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";

/**
 * Containers nested deeper than this render a summary instead of recursing.
 * Each level is a React component, so an unbounded depth overflows the stack.
 */
export const JSON_MAX_DEPTH = 64;

/**
 * An expanded container mounts this many children at first, then this many
 * more on request. Without a limit, one wide array mounts one subtree per item.
 */
export const JSON_CHILD_PAGE = 200;

/**
 * Structured, highlighted JSON. Keys, strings, numbers, booleans and nulls get
 * their own colours; containers collapse. A string with line breaks renders as
 * a text block, so agent output reads as prose instead of one escaped line.
 */
export function JsonTree({ value, openDepth = 3 }: { value: unknown; openDepth?: number }) {
  return (
    <div className="json-tree">
      <JsonNode value={value} depth={0} openDepth={openDepth} />
    </div>
  );
}

function JsonNode({
  value,
  depth,
  openDepth,
  name,
}: {
  value: unknown;
  depth: number;
  openDepth: number;
  name?: string | undefined;
}) {
  const label =
    name === undefined ? null : (
      <>
        <span className="json-key">{JSON.stringify(name)}</span>
        <span className="json-punct">: </span>
      </>
    );

  if (depth >= JSON_MAX_DEPTH && value !== null && typeof value === "object") {
    return (
      <div className="json-line">
        {label}
        <span className="json-summary">nested deeper than {JSON_MAX_DEPTH} levels, not shown</span>
      </div>
    );
  }

  if (Array.isArray(value)) {
    return (
      <Container
        label={label}
        open={["[", "]"]}
        value={value}
        depth={depth}
        openDepth={openDepth}
        name={name}
      />
    );
  }

  if (value !== null && typeof value === "object") {
    return (
      <Container
        label={label}
        open={["{", "}"]}
        value={value}
        depth={depth}
        openDepth={openDepth}
        name={name}
      />
    );
  }

  return (
    <div className="json-line">
      {label}
      <Primitive value={value} />
    </div>
  );
}

function Container({
  label,
  open,
  value,
  depth,
  openDepth,
  name,
}: {
  label: ReactNode;
  open: [string, string];
  value: unknown[] | object;
  depth: number;
  openDepth: number;
  name: string | undefined;
}) {
  const [expanded, setExpanded] = useState(depth < openDepth);
  const [shown, setShown] = useState(JSON_CHILD_PAGE);
  const [opening, closing] = open;
  const isArray = Array.isArray(value);
  // Keys are read only here, so a collapsed container costs one count, not a copy of its children.
  const keys = isArray ? null : Object.keys(value);
  const count = keys === null ? (value as unknown[]).length : keys.length;
  const what = name ?? "value";

  if (count === 0) {
    return (
      <div className="json-line">
        {label}
        <span className="json-punct">
          {opening}
          {closing}
        </span>
      </div>
    );
  }

  const visible = Math.min(shown, count);
  const remaining = count - visible;
  const children: ReactNode[] = [];
  for (let index = 0; index < visible; index += 1) {
    if (keys === null) {
      // A JSON array has no identity of its own, and its items are never reordered.
      children.push(
        <JsonNode
          key={index}
          value={(value as unknown[])[index]}
          depth={depth + 1}
          openDepth={openDepth}
        />,
      );
    } else {
      const key = keys[index] as string;
      children.push(
        <JsonNode
          key={key}
          value={(value as Record<string, unknown>)[key]}
          depth={depth + 1}
          openDepth={openDepth}
          name={key}
        />,
      );
    }
  }

  return (
    <div className="json-node">
      <div className="json-line">
        <button
          type="button"
          className="json-toggle"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${what}`}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? (
            <ChevronDown size={12} aria-hidden="true" />
          ) : (
            <ChevronRight size={12} aria-hidden="true" />
          )}
        </button>
        {label}
        <span className="json-punct">{opening}</span>
        {expanded ? null : (
          <span className="json-summary">
            {" "}
            {count} {count === 1 ? "item" : "items"}{" "}
          </span>
        )}
        {expanded ? null : <span className="json-punct">{closing}</span>}
      </div>
      {expanded ? (
        <div className="json-children">
          {children}
          {remaining > 0 ? (
            <div className="json-line">
              <button
                type="button"
                className="btn sm"
                data-testid="json-show-more"
                onClick={() => setShown((current) => current + JSON_CHILD_PAGE)}
              >
                Show {Math.min(JSON_CHILD_PAGE, remaining)} more ({remaining} left)
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {expanded ? (
        <div className="json-line">
          <span className="json-punct">{closing}</span>
        </div>
      ) : null}
    </div>
  );
}

function Primitive({ value }: { value: unknown }) {
  if (typeof value === "string") {
    if (value.includes("\n")) {
      return <div className="json-block">{value}</div>;
    }
    return <span className="json-str">{JSON.stringify(value)}</span>;
  }
  if (typeof value === "number") return <span className="json-num">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="json-bool">{String(value)}</span>;
  if (value === null || value === undefined) return <span className="json-null">null</span>;
  return <span className="json-str">{String(value)}</span>;
}

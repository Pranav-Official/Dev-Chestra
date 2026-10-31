import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";

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

  if (Array.isArray(value)) {
    return (
      <Container
        label={label}
        open={["[", "]"]}
        count={value.length}
        depth={depth}
        openDepth={openDepth}
        name={name}
      >
        {value.map((item, index) => (
          // A JSON array has no identity of its own, and its items are never reordered.
          // biome-ignore lint/suspicious/noArrayIndexKey: array position is the only identity
          <JsonNode key={index} value={item} depth={depth + 1} openDepth={openDepth} />
        ))}
      </Container>
    );
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return (
      <Container
        label={label}
        open={["{", "}"]}
        count={entries.length}
        depth={depth}
        openDepth={openDepth}
        name={name}
      >
        {entries.map(([key, item]) => (
          <JsonNode key={key} value={item} depth={depth + 1} openDepth={openDepth} name={key} />
        ))}
      </Container>
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
  count,
  depth,
  openDepth,
  name,
  children,
}: {
  label: ReactNode;
  open: [string, string];
  count: number;
  depth: number;
  openDepth: number;
  name: string | undefined;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(depth < openDepth);
  const [opening, closing] = open;
  const empty = count === 0;
  const what = name ?? "value";

  if (empty) {
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
      {expanded ? <div className="json-children">{children}</div> : null}
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

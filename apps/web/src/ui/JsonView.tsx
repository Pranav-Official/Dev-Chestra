// biome-ignore-all lint/a11y/noNoninteractiveTabindex: the expanded JSON must be keyboard reachable
import { Copy, Maximize2 } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Dialog } from "../editor/controls/Dialog.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { jsonText } from "./format.js";
import { JsonTree } from "./JsonTree.js";
import { useKeepHeight } from "./useKeepHeight.js";

/** Formatted JSON at or under both limits renders in full, inline. */
const INLINE_MAX_CHARS = 320;
const INLINE_MAX_LINES = 12;

/**
 * The dialog opens containers this many levels deep. Deeper containers start
 * collapsed and expand on demand, so mounted nodes stay proportional to what
 * the reader has opened.
 */
const DIALOG_OPEN_DEPTH = 6;
/**
 * Above this many values, the dialog opens only the top level. Every value
 * that starts expanded mounts one React subtree per child, so a large payload
 * fully opened would freeze the viewer.
 */
const DIALOG_MAX_NODES = 5000;

export function JsonView({
  value,
  testId,
  label = "Value",
}: {
  value: unknown;
  testId?: string;
  label?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  // Serialising is O(n) in the payload, so it runs once per value, not per render.
  const { text, lines, summary, nodes } = useMemo(() => {
    const serialised = jsonText(value);
    const lineCount = serialised === "" ? 0 : serialised.split("\n").length;
    const byteCount = new TextEncoder().encode(serialised).length;
    return {
      text: serialised,
      lines: lineCount,
      summary: `${lineCount} ${lineCount === 1 ? "line" : "lines"} · ${byteCount} bytes`,
      nodes: safeCountNodes(value),
    };
  }, [value]);
  if (text === "") return <pre className="code" data-testid={testId} />;

  // Keyed by the text, so a new value starts from its own height, not the last one.
  if (text.length <= INLINE_MAX_CHARS && lines <= INLINE_MAX_LINES) {
    return (
      <KeptBox key={text} className="json-inline" testId={testId}>
        <Tree value={value} fallback={text} />
      </KeptBox>
    );
  }

  const copy = (): void => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  const large = nodes > DIALOG_MAX_NODES;

  return (
    <KeptBox key={text} className="json-preview" testId={testId}>
      <div className="json-preview-body">
        <Tree value={value} fallback={text} openDepth={1} />
      </div>
      <div className="json-preview-foot">
        <span className="faint">{summary}</span>
        <button
          type="button"
          className="btn sm"
          aria-haspopup="dialog"
          onClick={() => setExpanded(true)}
        >
          <Maximize2 size={12} aria-hidden="true" />
          Expand
        </button>
      </div>
      {expanded ? (
        <Dialog
          open
          title={label}
          description={summary}
          onClose={() => setExpanded(false)}
          wide
          bodyClassName="json-dialog-frame"
          {...(testId === undefined ? {} : { testId: `${testId}-dialog` })}
          footer={
            <button type="button" className="btn sm" onClick={copy}>
              <Copy size={12} aria-hidden="true" />
              {copied ? "Copied" : "Copy JSON"}
            </button>
          }
        >
          <section className="json-dialog-body" tabIndex={0} aria-label={label}>
            {large ? (
              <p className="faint json-dialog-note" data-testid="json-large-notice">
                This value is large. Nested items start collapsed, and long lists show 200 entries
                at a time.
              </p>
            ) : null}
            <Tree value={value} fallback={text} openDepth={large ? 1 : DIALOG_OPEN_DEPTH} />
          </section>
        </Dialog>
      ) : null}
    </KeptBox>
  );
}

/**
 * A tree that a render failure cannot take down. The fallback is the raw
 * text, so the reader still gets the value.
 */
function Tree({
  value,
  fallback,
  openDepth,
}: {
  value: unknown;
  fallback: string;
  openDepth?: number;
}) {
  return (
    <ErrorBoundary fallback={<pre className="code">{fallback}</pre>}>
      <JsonTree value={value} {...(openDepth === undefined ? {} : { openDepth })} />
    </ErrorBoundary>
  );
}

/** A value that cannot be walked counts as large, so the dialog stays collapsed. */
function safeCountNodes(value: unknown): number {
  try {
    return countNodes(value, DIALOG_MAX_NODES);
  } catch {
    return DIALOG_MAX_NODES + 1;
  }
}

/**
 * Counts values in the payload, stopping once `limit` is passed. Iterative,
 * so a deeply nested payload cannot overflow the stack while being measured.
 */
function countNodes(root: unknown, limit: number): number {
  const stack: unknown[] = [root];
  let count = 0;
  while (stack.length > 0 && count <= limit) {
    const current = stack.pop();
    count += 1;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
    } else if (current !== null && typeof current === "object") {
      for (const item of Object.values(current)) stack.push(item);
    }
  }
  return count;
}

/**
 * A box that never shrinks while mounted. Collapsing a node inside it leaves
 * the box at its size, so neither the panel nor the dialog jumps.
 */
function KeptBox({
  className,
  testId,
  children,
}: {
  className: string;
  testId: string | undefined;
  children: ReactNode;
}) {
  const { ref, style } = useKeepHeight<HTMLDivElement>();
  return (
    <div ref={ref} className={className} style={style} data-testid={testId}>
      {children}
    </div>
  );
}

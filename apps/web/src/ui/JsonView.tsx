// biome-ignore-all lint/a11y/noNoninteractiveTabindex: the expanded JSON must be keyboard reachable
import { Copy, Maximize2 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Dialog } from "../editor/controls/Dialog.js";
import { jsonText } from "./format.js";
import { JsonTree } from "./JsonTree.js";
import { useKeepHeight } from "./useKeepHeight.js";

/** Formatted JSON at or under both limits renders in full, inline. */
const INLINE_MAX_CHARS = 320;
const INLINE_MAX_LINES = 12;

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
  const text = jsonText(value);
  if (text === "") return <pre className="code" data-testid={testId} />;

  const lines = text.split("\n").length;
  const bytes = new TextEncoder().encode(text).length;
  const summary = `${lines} ${lines === 1 ? "line" : "lines"} · ${bytes} bytes`;

  // Keyed by the text, so a new value starts from its own height, not the last one.
  if (text.length <= INLINE_MAX_CHARS && lines <= INLINE_MAX_LINES) {
    return (
      <KeptBox key={text} className="json-inline" testId={testId}>
        <JsonTree value={value} />
      </KeptBox>
    );
  }

  const copy = (): void => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <KeptBox key={text} className="json-preview" testId={testId}>
      <div className="json-preview-body">
        <JsonTree value={value} openDepth={1} />
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
          {...(testId === undefined ? {} : { testId: `${testId}-dialog` })}
          footer={
            <button type="button" className="btn sm" onClick={copy}>
              <Copy size={12} aria-hidden="true" />
              {copied ? "Copied" : "Copy JSON"}
            </button>
          }
        >
          <section className="json-dialog-body" tabIndex={0} aria-label={label}>
            <JsonTree value={value} openDepth={Number.POSITIVE_INFINITY} />
          </section>
        </Dialog>
      ) : null}
    </KeptBox>
  );
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

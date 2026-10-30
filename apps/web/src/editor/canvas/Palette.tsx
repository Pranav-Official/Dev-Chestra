import type { WorkflowFile } from "@devchestra/schema";
import {
  Bot,
  Files,
  Flag,
  GitBranch,
  GitMerge,
  ListOrdered,
  Play,
  Plus,
  Repeat,
  Scale,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { Position } from "../model/types.js";

interface PaletteItem {
  type: string;
  label: string;
  description: string;
  icon: typeof Play;
}

const ITEMS: readonly PaletteItem[] = [
  { type: "start", label: "Start", description: "Run inputs.", icon: Play },
  { type: "agent", label: "Agent", description: "Run an agent step.", icon: Bot },
  { type: "shell", label: "Shell", description: "Run a command.", icon: TerminalSquare },
  { type: "gate", label: "Gate", description: "Route by condition.", icon: GitBranch },
  { type: "join", label: "Join", description: "Merge branches.", icon: GitMerge },
  { type: "approval", label: "Approval", description: "Pause for a person.", icon: ShieldCheck },
  { type: "decision", label: "Decision", description: "Ask a decision model.", icon: Scale },
  { type: "loop", label: "Loop", description: "Repeat until condition.", icon: Repeat },
  {
    type: "foreach",
    label: "For each",
    description: "Process every item sequentially.",
    icon: ListOrdered,
  },
  {
    type: "workflow",
    label: "Run workflow",
    description: "Run a reusable workflow and wait.",
    icon: Files,
  },
  { type: "end", label: "End", description: "Finish the run.", icon: Flag },
];

export interface NodePaletteProps {
  file: WorkflowFile;
  onAdd(type: string, position?: Position): void;
  disabled?: boolean;
  hiddenTypes?: readonly string[];
}

/** Canvas overlay: the menu occupies no workspace column, including inside loop dialogs. */
export function NodePalette({ file, onAdd, disabled = false, hiddenTypes = [] }: NodePaletteProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const present = new Set(file.graph.nodes.map((node) => node.type));
  const hidden = new Set(hiddenTypes);
  const items = ITEMS.filter(
    (item) => !hidden.has(item.type) && (item.type !== "start" || !present.has(item.type)),
  );

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const doc = root.current?.ownerDocument ?? document;
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    doc.addEventListener("mousedown", outside);
    doc.addEventListener("keydown", dismissOnEscape, true);
    return () => {
      doc.removeEventListener("mousedown", outside);
      doc.removeEventListener("keydown", dismissOnEscape, true);
    };
  }, [open]);

  return (
    <div className="editor-node-add" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="btn editor-node-add-trigger"
        data-testid="palette-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Plus size={16} aria-hidden="true" />
        Add node
      </button>
      {open ? (
        <div
          ref={menu}
          id={menuId}
          className="editor-palette"
          role="menu"
          aria-label="Add a node"
          onKeyDown={(event) => {
            const buttons = [
              ...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
            ];
            if (buttons.length === 0) return;
            const index = buttons.indexOf(event.target as HTMLButtonElement);
            let next: number;
            if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
            else if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = buttons.length - 1;
            else return;
            event.preventDefault();
            buttons[next]?.focus();
          }}
          onBlur={(event) => {
            if (event.relatedTarget && !root.current?.contains(event.relatedTarget as Node))
              setOpen(false);
          }}
        >
          <div className="editor-palette-title">Add a node</div>
          <div className="editor-palette-list" role="none">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.type}
                  type="button"
                  role="menuitem"
                  className="editor-palette-item"
                  data-testid={`palette-add-${item.type}`}
                  disabled={disabled}
                  draggable={!disabled}
                  onClick={() => {
                    onAdd(item.type);
                    setOpen(false);
                    trigger.current?.focus();
                  }}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/node", item.type);
                    event.dataTransfer.setData("application/devchestra-node", item.type);
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  onDragEnd={() => setOpen(false)}
                >
                  <span className={`editor-palette-icon editor-palette-icon-${item.type}`}>
                    <Icon size={18} aria-hidden="true" />
                  </span>
                  <span className="editor-palette-copy">
                    <span className="editor-palette-label">{item.label}</span>
                    <span className="editor-palette-hint">{item.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

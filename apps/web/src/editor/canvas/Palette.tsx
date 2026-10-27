import type { WorkflowFile } from "@relay/schema";
import { Bot, Flag, GitBranch, GitMerge, Play, ShieldCheck, TerminalSquare } from "lucide-react";
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
  { type: "end", label: "End", description: "Finish the run.", icon: Flag },
];

export interface NodePaletteProps {
  file: WorkflowFile;
  onAdd(type: string, position?: Position): void;
  disabled?: boolean;
}

export function NodePalette({ file, onAdd, disabled = false }: NodePaletteProps) {
  const present = new Set(file.graph.nodes.map((node) => node.type));
  const items = ITEMS.filter((item) => item.type !== "start" || !present.has(item.type));
  return (
    <aside className="editor-palette" aria-label="Add a node">
      <div className="editor-palette-title">Add a node</div>
      <div className="editor-palette-list">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.type}
              type="button"
              className="editor-palette-item"
              data-testid={`palette-add-${item.type}`}
              disabled={disabled}
              draggable={!disabled}
              onClick={() => onAdd(item.type)}
              onDragStart={(event) => {
                event.dataTransfer.setData("text/node", item.type);
                event.dataTransfer.setData("application/relay-node", item.type);
                event.dataTransfer.effectAllowed = "copy";
              }}
            >
              <span className={`editor-palette-icon editor-palette-icon-${item.type}`}>
                <Icon size={14} aria-hidden="true" />
              </span>
              <span className="editor-palette-copy">
                <span className="editor-palette-label">{item.label}</span>
                <span className="editor-palette-hint">{item.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

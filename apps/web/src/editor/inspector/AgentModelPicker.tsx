import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "../../styles/editor-model-picker.css";
import type { CliModelCatalog, CliModelItem } from "./model/catalog.js";
import { rankModels } from "./model/rank.js";
import type { CatalogLoading } from "./model/useCliModelCatalog.js";

export interface AgentModelPickerProps {
  id: string;
  value: string | undefined;
  catalog: CliModelCatalog | null;
  loading: CatalogLoading;
  error: string | null;
  projectId?: string | undefined;
  open: boolean;
  describedBy?: string | undefined;
  invalid?: boolean;
  disabled?: boolean;
  onOpenChange(open: boolean): void;
  onSelect(modelId: string): void;
  onUseDefault(): void;
  onRefresh(): void;
}

type Option =
  | { kind: "default"; id: string }
  | { kind: "model"; id: string; index: number; item: CliModelItem };

const STATUS_LABEL: Record<string, string> = {
  ready: "Ready",
  stale: "Stale cache",
  unsupported: "Model listing unavailable",
  unavailable: "Unavailable",
  authRequired: "Authentication required",
  loading: "Loading models",
  refreshing: "Refreshing",
  notLoaded: "Not loaded",
};

function controlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function limitation(status: string, catalog: CliModelCatalog | null): string | null {
  if (catalog?.message !== undefined && catalog.message !== "") return catalog.message;
  switch (status) {
    case "unsupported":
      return "This CLI does not expose a supported model catalog. Use the CLI default or enter a custom model ID.";
    case "unavailable":
      return "Model discovery is unavailable. The CLI default and a custom model ID still work.";
    case "authRequired":
      return "The CLI needs authentication before models can be discovered. The CLI default and a custom model ID still work.";
    case "stale":
      return "Showing the last known catalog. It may not match the current account, CLI version or settings.";
    case "loading":
      return "Loading the cached runtime catalog.";
    case "notLoaded":
      return "Open the picker to load the cached runtime catalog.";
    case "refreshing":
      return "Refreshing the runtime catalog.";
    default:
      return null;
  }
}

export function AgentModelPicker({
  id,
  value,
  catalog,
  loading,
  error,
  projectId,
  open,
  describedBy,
  invalid = false,
  disabled = false,
  onOpenChange,
  onSelect,
  onUseDefault,
  onRefresh,
}: AgentModelPickerProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState(value ?? "");
  const listboxRef = useRef<HTMLDivElement | null>(null);

  const listboxId = `${id}-listbox`;
  const defaultOptionId = `${id}-option-default`;

  const filtered = useMemo(() => rankModels(catalog?.items ?? [], query), [catalog, query]);

  const options = useMemo<Option[]>(() => {
    const defaultOption: Option = { kind: "default", id: defaultOptionId };
    return [
      defaultOption,
      ...filtered.map((item, index) => ({
        kind: "model" as const,
        id: `${id}-option-${index}`,
        index,
        item,
      })),
    ];
  }, [defaultOptionId, filtered, id]);

  const selectedItem =
    value === undefined ? undefined : catalog?.items.find((item) => item.id === value);
  const selectedLabel =
    value === undefined ? "Use CLI default" : (selectedItem?.label ?? "Saved model (unverified)");

  let status: string;
  if (error !== null) status = catalog === null ? "unavailable" : "stale";
  else if (loading === "refresh") status = "refreshing";
  else if (loading === "load") status = "loading";
  else if (catalog !== null) status = catalog.status;
  else status = projectId === undefined ? "unavailable" : "notLoaded";

  const message =
    error ??
    (projectId === undefined
      ? "Model discovery needs a project context. The CLI default and a custom model ID still work."
      : limitation(status, catalog));

  const stale = status === "stale";
  const customProblem = controlCharacter(customValue)
    ? "Model IDs cannot contain control characters."
    : null;
  const customReady = customValue.trim() !== "" && customProblem === null;
  const activeOption = options[Math.min(activeIndex, options.length - 1)];
  const activeOptionId = activeOption?.id;

  useEffect(() => {
    if (!open || activeOptionId === undefined) return;
    const option = listboxRef.current?.querySelector<HTMLElement>(`#${activeOptionId}`);
    if (option !== null && option !== undefined && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  }, [activeOptionId, open]);

  useEffect(() => {
    setCustomValue(value ?? "");
  }, [value]);

  useEffect(() => {
    if (open) return;
    setQuery("");
    setActiveIndex(0);
    setCustomValue(value ?? "");
  }, [open, value]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, options.length - 1));
  }, [options.length]);

  const close = useCallback(() => {
    setQuery("");
    setActiveIndex(0);
    setCustomValue(value ?? "");
    onOpenChange(false);
  }, [onOpenChange, value]);

  const choose = useCallback(
    (option: Option | undefined) => {
      if (option === undefined) return;
      if (option.kind === "default") onUseDefault();
      else onSelect(option.item.id);
      close();
    },
    [close, onSelect, onUseDefault],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) {
          setActiveIndex(0);
          onOpenChange(true);
          return;
        }
        setActiveIndex((current) => Math.min(current + 1, options.length - 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        if (!open) {
          setActiveIndex(0);
          onOpenChange(true);
          return;
        }
        setActiveIndex((current) => Math.max(current - 1, 0));
        return;
      case "Home":
        if (!open) return;
        event.preventDefault();
        setActiveIndex(0);
        return;
      case "End":
        if (!open) return;
        event.preventDefault();
        setActiveIndex(options.length - 1);
        return;
      case "Enter":
        event.preventDefault();
        if (!open) {
          onOpenChange(true);
          return;
        }
        choose(activeOption);
        return;
      case "Escape":
        if (!open) return;
        event.preventDefault();
        close();
        return;
      default:
        return;
    }
  };

  return (
    <fieldset
      className="model-picker nowheel nopan nodrag"
      aria-label="Model selector"
      data-open={open ? "true" : undefined}
      data-testid="inspector-agent-model-field"
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        close();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="model-picker-selected">
        <span
          className="model-picker-selected-label"
          data-testid="inspector-agent-model-selected-label"
        >
          {selectedLabel}
        </span>
        <span
          className="model-picker-selected-id mono"
          data-testid="inspector-agent-model-selected-id"
        >
          {value ?? "CLI default"}
        </span>
      </div>

      <div className="model-picker-combo">
        <input
          id={id}
          className="inspector-input model-picker-input"
          data-testid="inspector-agent-model-picker"
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={query}
          placeholder="Search models, or use the CLI default"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={open ? activeOption?.id : undefined}
          aria-describedby={describedBy}
          aria-invalid={invalid ? true : undefined}
          aria-busy={loading !== "idle"}
          onFocus={() => {
            if (!open) {
              setQuery("");
              setActiveIndex(0);
              onOpenChange(true);
            }
          }}
          onClick={() => {
            if (!open) onOpenChange(true);
          }}
          onChange={(event) => {
            const nextQuery = event.currentTarget.value;
            const matches = rankModels(catalog?.items ?? [], nextQuery);
            setQuery(nextQuery);
            setActiveIndex(nextQuery.trim() === "" || matches.length === 0 ? 0 : 1);
            if (!open) onOpenChange(true);
          }}
          onKeyDown={handleKeyDown}
        />

        {open ? (
          <div
            ref={listboxRef}
            className="model-picker-listbox"
            data-testid="inspector-agent-model-listbox"
            id={listboxId}
            role="listbox"
            tabIndex={-1}
            aria-label="Model options"
          >
            {options.map((option) => {
              const selected =
                option.kind === "default" ? value === undefined : value === option.item.id;
              const active = option.id === activeOption?.id;
              if (option.kind === "default") {
                return (
                  <div
                    key={option.id}
                    id={option.id}
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected}
                    className={`model-picker-option${active ? " active" : ""}`}
                    data-testid="inspector-agent-model-default"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(option)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        choose(option);
                      }
                    }}
                  >
                    <span className="model-picker-option-label">Use CLI default</span>
                    <span className="model-picker-option-id mono">No model override</span>
                  </div>
                );
              }
              const item = option.item;
              return (
                <div
                  key={option.id}
                  id={option.id}
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected}
                  className={`model-picker-option${active ? " active" : ""}`}
                  data-testid={`inspector-agent-model-option-${option.index}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      choose(option);
                    }
                  }}
                >
                  <span className="model-picker-option-head">
                    <span className="model-picker-option-label">{item.label}</span>
                    {item.isDefault === true ? (
                      <span className="model-picker-badge">Native default</span>
                    ) : null}
                  </span>
                  <span className="model-picker-option-id mono">{item.id}</span>
                  <span className="model-picker-meta">
                    {item.provider === undefined ? null : <span>{item.provider}</span>}
                    {item.aliases !== undefined && item.aliases.length > 0 ? (
                      <span>Aliases: {item.aliases.join(", ")}</span>
                    ) : null}
                    {item.description === undefined ? null : <span>{item.description}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="model-picker-controls">
        <button
          type="button"
          className="btn sm"
          data-testid="inspector-agent-model-refresh"
          disabled={disabled || loading !== "idle" || projectId === undefined}
          onClick={onRefresh}
        >
          {loading === "refresh"
            ? "Refreshing…"
            : loading === "load"
              ? "Loading…"
              : catalog === null
                ? "Load models"
                : "Refresh models"}
        </button>
        <span
          className="model-picker-status"
          role="status"
          data-testid="inspector-agent-model-status"
        >
          {STATUS_LABEL[status] ?? status}
        </span>
        <span className="model-picker-source" data-testid="inspector-agent-model-source">
          Runtime catalog · scope: {catalog?.scope ?? "devchestra-runtime"} · source:{" "}
          {catalog?.source ?? "none"}
        </span>
        <span className="model-picker-count" data-testid="inspector-agent-model-count">
          {filtered.length} of {catalog?.items.length ?? 0}
        </span>
        {stale ? (
          <span className="model-picker-stale" data-testid="inspector-agent-model-stale">
            Stale
          </span>
        ) : null}
      </div>

      {message === null ? null : (
        <p
          className="inspector-help model-picker-message"
          data-testid="inspector-agent-model-message"
        >
          {message}
        </p>
      )}

      <details
        className="model-picker-custom"
        open={open || customOpen}
        onToggle={(event) => setCustomOpen(event.currentTarget.open)}
      >
        <summary className="model-picker-custom-summary">Custom model ID</summary>
        <label className="model-picker-sr" htmlFor={`${id}-custom`}>
          Use custom model ID
        </label>
        <div className="model-picker-custom-row">
          <input
            id={`${id}-custom`}
            className="inspector-input mono"
            data-testid="inspector-agent-model-custom-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            value={customValue}
            aria-invalid={customProblem === null ? undefined : true}
            onChange={(event) => setCustomValue(event.currentTarget.value)}
          />
          <button
            type="button"
            className="btn sm"
            data-testid="inspector-agent-model-use-custom"
            disabled={disabled || !customReady}
            onClick={() => {
              if (!customReady) return;
              onSelect(customValue);
              close();
            }}
          >
            Use custom model ID
          </button>
        </div>
        {customProblem === null ? null : (
          <p className="inspector-error" role="alert">
            {customProblem}
          </p>
        )}
      </details>
    </fieldset>
  );
}

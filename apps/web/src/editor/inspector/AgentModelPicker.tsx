import type { AgentCli } from "@devchestra/schema";
import { Check, ChevronDown, RefreshCw } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ProviderIcon } from "../../ui/ProviderIcon.js";
import "../../styles/editor-model-picker.css";
import { useAnchoredPopover } from "./fields/useAnchoredPopover.js";
import type { CliModelCatalog, CliModelItem } from "./model/catalog.js";
import { rankModels } from "./model/rank.js";
import type { CatalogLoading } from "./model/useCliModelCatalog.js";

export interface AgentModelPickerProps {
  id: string;
  cli: AgentCli;
  cliLabel: string;
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

/** Rows rendered at most; past this the list asks for a narrower search. */
const MAX_MODEL_ROWS = 200;

type Option =
  | { kind: "default"; id: string }
  | { kind: "model"; id: string; item: CliModelItem; index: number }
  | { kind: "custom"; id: string; value: string; blocked: boolean };

type Row =
  | { kind: "option"; option: Option }
  | { kind: "group"; key: string; label: string }
  | { kind: "note"; text: string };

interface Layout {
  rows: Row[];
  options: Option[];
}

function controlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Coarse "updated" age for the footer; `now` is passed in so tests can pin it. */
export function catalogAgeLabel(fetchedAt: number, now: number): string {
  const minutes = Math.floor((now - fetchedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function buildLayout(id: string, items: readonly CliModelItem[], query: string): Layout {
  const search = query.trim();
  const ranked = search === "" ? items : rankModels(items, query);
  const providers = new Set(items.map((item) => item.provider).filter((name) => !!name));
  const grouped = search === "" && providers.size > 1;
  const shown = ranked.slice(0, MAX_MODEL_ROWS);

  const rows: Row[] = [];
  const options: Option[] = [];
  const add = (option: Option) => {
    options.push(option);
    rows.push({ kind: "option", option });
  };

  add({ kind: "default", id: `${id}-option-default` });
  let previous: string | undefined;
  shown.forEach((item, index) => {
    const provider = item.provider ?? "";
    if (grouped && provider !== previous) {
      rows.push({ kind: "group", key: `${index}`, label: provider || "Other" });
    }
    previous = provider;
    add({ kind: "model", id: `${id}-option-${index}`, item, index });
  });

  if (ranked.length > shown.length) {
    rows.push({ kind: "note", text: `${ranked.length - shown.length} more. Refine your search.` });
  }
  if (items.length === 0) rows.push({ kind: "note", text: "No models to list." });
  else if (ranked.length === 0) rows.push({ kind: "note", text: "No models match." });

  if (search !== "" && !items.some((item) => item.id === search)) {
    add({
      kind: "custom",
      id: `${id}-option-custom`,
      value: search,
      blocked: controlCharacter(query),
    });
  }
  return { rows, options };
}

function detailOf(item: CliModelItem): string {
  const parts = [
    item.description,
    item.aliases !== undefined && item.aliases.length > 0
      ? `Aliases: ${item.aliases.join(", ")}`
      : undefined,
  ];
  return parts.filter((part): part is string => part !== undefined && part !== "").join(" · ");
}

const COPY = {
  noProject: "Open this workflow from a project to list models. You can still type a model ID.",
  stale: "Showing the saved list. It may be out of date.",
  unavailable: "Couldn't load models. Type a model ID to continue.",
};

/** The one-line banner, shown only when the catalog is not usable. */
function bannerFor(input: {
  projectId: string | undefined;
  catalog: CliModelCatalog | null;
  error: string | null;
  loading: CatalogLoading;
  cliLabel: string;
}): { text: string; warn: boolean } | null {
  if (input.projectId === undefined) return { text: COPY.noProject, warn: false };
  if (input.loading !== "idle") return null;
  if (input.error !== null) {
    return input.catalog === null
      ? { text: COPY.unavailable, warn: false }
      : { text: COPY.stale, warn: true };
  }
  switch (input.catalog?.status) {
    case "stale":
      return { text: COPY.stale, warn: true };
    case "authRequired":
      return {
        text: `Sign in to ${input.cliLabel} to list models. You can still type a model ID.`,
        warn: false,
      };
    case "unavailable":
      return { text: COPY.unavailable, warn: false };
    case "unsupported":
      return {
        text: `${input.cliLabel} doesn't list models. Use the default or type a model ID.`,
        warn: false,
      };
    default:
      return null;
  }
}

function footerText(catalog: CliModelCatalog | null, loading: CatalogLoading): string {
  if (loading === "load") return "Loading models…";
  if (loading === "refresh") return "Refreshing…";
  if (catalog === null) return "";
  const count = `${catalog.items.length} ${catalog.items.length === 1 ? "model" : "models"}`;
  return catalog.fetchedAt === null
    ? count
    : `${count} · updated ${catalogAgeLabel(catalog.fetchedAt, Date.now())}`;
}

function footerTitle(catalog: CliModelCatalog | null): string | undefined {
  if (catalog === null) return undefined;
  const parts = ["Runtime catalog", `source: ${catalog.source}`];
  if (catalog.cliVersion !== null) parts.push(`CLI ${catalog.cliVersion}`);
  return parts.join(" · ");
}

export function AgentModelPicker({
  id,
  cli,
  cliLabel,
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
  const [activeId, setActiveId] = useState("");
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);

  const isOpen = open && !disabled;
  const listboxId = `${id}-listbox`;
  const defaultOptionId = `${id}-option-default`;
  const items = useMemo(() => catalog?.items ?? [], [catalog]);

  const fullLayout = useMemo(() => buildLayout(id, items, ""), [id, items]);
  const layout = useMemo(() => buildLayout(id, items, query), [id, items, query]);
  const selectedItem = value === undefined ? undefined : items.find((item) => item.id === value);
  const selectedOptionId =
    fullLayout.options.find((option) => option.kind === "model" && option.item === selectedItem)
      ?.id ?? defaultOptionId;
  const active = layout.options.find((option) => option.id === activeId) ?? layout.options[0];
  const activeDomId = active?.id ?? "";

  const close = useCallback(() => {
    setQuery("");
    setActiveId("");
    onOpenChange(false);
  }, [onOpenChange]);

  const { style } = useAnchoredPopover({
    open: isOpen,
    onClose: close,
    anchorRef,
    popRef,
    minWidth: 340,
    maxHeight: 420,
    minHeight: 280,
  });

  useEffect(() => {
    if (!isOpen) return;
    setActiveId(selectedOptionId);
    inputRef.current?.focus();
  }, [isOpen, selectedOptionId]);

  useEffect(() => {
    if (!isOpen || activeDomId === "") return;
    const option = listboxRef.current?.querySelector<HTMLElement>(`[id="${activeDomId}"]`);
    option?.scrollIntoView?.({ block: "nearest" });
  }, [activeDomId, isOpen]);

  const choose = (option: Option | undefined) => {
    if (option === undefined) return;
    if (option.kind === "custom") {
      if (option.blocked) return;
      onSelect(option.value);
    } else if (option.kind === "default") {
      onUseDefault();
    } else {
      onSelect(option.item.id);
    }
    close();
    anchorRef.current?.focus();
  };

  const moveTo = (index: number) => {
    const clamped = Math.max(0, Math.min(index, layout.options.length - 1));
    setActiveId(layout.options[clamped]?.id ?? "");
  };

  const activeIndex = Math.max(
    0,
    layout.options.findIndex((option) => option.id === activeDomId),
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveTo(activeIndex + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        moveTo(activeIndex - 1);
        return;
      case "Home":
        event.preventDefault();
        moveTo(0);
        return;
      case "End":
        event.preventDefault();
        moveTo(layout.options.length - 1);
        return;
      case "Enter":
        event.preventDefault();
        choose(active);
        return;
      case "Tab":
        close();
        return;
      default:
        return;
    }
  };

  const banner = bannerFor({ projectId, catalog, error, loading, cliLabel });
  const isUnknown = value !== undefined && selectedItem === undefined;
  const isDefault = value === undefined;

  const renderOption = (option: Option) => {
    const selected =
      option.kind === "default"
        ? value === undefined
        : option.kind === "model"
          ? option.item === selectedItem
          : false;
    const isActive = option.id === activeDomId;
    const className = `model-picker-option${isActive ? " active" : ""}`;
    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        choose(option);
      }
    };

    if (option.kind === "default") {
      return (
        <div
          id={option.id}
          role="option"
          tabIndex={-1}
          aria-selected={selected}
          className={className}
          data-testid="inspector-agent-model-default"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(option)}
          onKeyDown={onKeyDown}
        >
          <span className="model-picker-option-line">
            <span className="model-picker-option-label">CLI default</span>
            <span className="model-picker-option-muted">no override</span>
            {selected ? (
              <Check size={14} aria-hidden="true" className="model-picker-check" />
            ) : null}
          </span>
        </div>
      );
    }

    if (option.kind === "custom") {
      return (
        <div
          id={option.id}
          role="option"
          tabIndex={-1}
          aria-selected={false}
          aria-disabled={option.blocked ? true : undefined}
          className={className}
          data-testid="inspector-agent-model-custom-option"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(option)}
          onKeyDown={onKeyDown}
        >
          <span className="model-picker-option-line">
            {option.blocked ? (
              <span className="model-picker-option-muted">
                Model IDs cannot contain control characters.
              </span>
            ) : (
              <span className="model-picker-option-label">
                {`Use "${option.value}" as custom model ID`}
              </span>
            )}
          </span>
        </div>
      );
    }

    const { item } = option;
    const detail = detailOf(item);
    return (
      <div
        id={option.id}
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        className={className}
        title={item.description}
        data-testid={`inspector-agent-model-option-${option.index}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(option)}
        onKeyDown={onKeyDown}
      >
        <span className="model-picker-option-line">
          <span className="model-picker-option-label">{item.label}</span>
          {item.id === item.label ? null : (
            <span className="model-picker-option-id mono">{item.id}</span>
          )}
          {item.isDefault === true ? <span className="model-picker-badge">Default</span> : null}
          {query.trim() !== "" && item.provider ? (
            <span className="model-picker-option-provider">{item.provider}</span>
          ) : null}
          {selected ? <Check size={14} aria-hidden="true" className="model-picker-check" /> : null}
        </span>
        {isActive && detail !== "" ? (
          <span className="model-picker-option-detail">{detail}</span>
        ) : null}
      </div>
    );
  };

  return (
    <fieldset
      className="model-picker nowheel nopan nodrag"
      aria-label="Model selector"
      data-testid="inspector-agent-model-field"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        ref={anchorRef}
        id={id}
        type="button"
        className="model-picker-trigger"
        data-testid="inspector-agent-model-trigger"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid ? true : undefined}
        disabled={disabled}
        onClick={() => (isOpen ? close() : onOpenChange(true))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !isOpen) {
            event.preventDefault();
            onOpenChange(true);
          }
        }}
      >
        <ProviderIcon cli={cli} size={14} />
        <span
          className="model-picker-selected-label"
          data-testid="inspector-agent-model-selected-label"
        >
          {isDefault ? "CLI default" : isUnknown ? "Custom" : (selectedItem?.label ?? "")}
        </span>
        {isDefault ? (
          <span
            className="model-picker-selected-id model-picker-muted"
            data-testid="inspector-agent-model-selected-id"
          >
            {`uses ${cliLabel}'s own default`}
          </span>
        ) : null}
        {isUnknown || (selectedItem !== undefined && selectedItem.id !== selectedItem.label) ? (
          <span
            className="model-picker-selected-id mono"
            data-testid="inspector-agent-model-selected-id"
          >
            {value}
          </span>
        ) : null}
        {isUnknown && catalog !== null ? (
          <span className="model-picker-hint">not in catalog</span>
        ) : null}
        <ChevronDown size={14} aria-hidden="true" className="model-picker-chevron" />
      </button>

      {isOpen
        ? createPortal(
            <div
              ref={popRef}
              className="model-popover"
              style={style}
              data-testid="inspector-agent-model-popover"
            >
              <input
                ref={inputRef}
                id={`${id}-search`}
                className="inspector-input model-picker-search"
                data-testid="inspector-agent-model-picker"
                type="text"
                role="combobox"
                aria-label="Search models"
                aria-expanded
                aria-controls={listboxId}
                aria-autocomplete="list"
                aria-activedescendant={activeDomId === "" ? undefined : activeDomId}
                autoComplete="off"
                spellCheck={false}
                placeholder="Search models"
                value={query}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setQuery(next);
                  const nextLayout = buildLayout(id, items, next);
                  setActiveId(
                    next.trim() === ""
                      ? selectedOptionId
                      : (nextLayout.options[1]?.id ?? nextLayout.options[0]?.id ?? ""),
                  );
                }}
                onKeyDown={handleKeyDown}
              />

              {banner === null ? null : (
                <p
                  className="model-picker-message"
                  role="status"
                  data-tone={banner.warn ? "warn" : undefined}
                  data-testid="inspector-agent-model-message"
                  title={catalog?.message}
                >
                  {banner.text}
                </p>
              )}

              <div
                ref={listboxRef}
                className="model-picker-listbox"
                id={listboxId}
                role="listbox"
                aria-label="Model options"
                data-testid="inspector-agent-model-listbox"
              >
                {layout.rows.map((row) => {
                  if (row.kind === "group") {
                    return (
                      <div
                        key={`group-${row.key}`}
                        className="model-picker-group"
                        role="presentation"
                      >
                        {row.label}
                      </div>
                    );
                  }
                  if (row.kind === "note") {
                    return (
                      <div
                        key={`note-${row.text}`}
                        className="model-picker-note"
                        role="presentation"
                      >
                        {row.text}
                      </div>
                    );
                  }
                  return <Fragment key={row.option.id}>{renderOption(row.option)}</Fragment>;
                })}
              </div>

              <div className="model-picker-footer">
                <span
                  className="model-picker-status"
                  data-testid="inspector-agent-model-status"
                  title={footerTitle(catalog)}
                >
                  {footerText(catalog, loading)}
                </span>
                <button
                  type="button"
                  className="model-picker-refresh"
                  data-testid="inspector-agent-model-refresh"
                  aria-label="Refresh models"
                  disabled={disabled || loading !== "idle" || projectId === undefined}
                  onClick={onRefresh}
                >
                  <RefreshCw
                    size={13}
                    aria-hidden="true"
                    className={loading === "idle" ? undefined : "model-picker-spin"}
                  />
                </button>
              </div>
            </div>,
            // Inside the enclosing modal <dialog> (top layer) when there is one: a
            // popover portaled to body would render beneath the dialog and be inert.
            anchorRef.current?.closest("dialog") ??
              anchorRef.current?.ownerDocument.body ??
              document.body,
          )
        : null}
    </fieldset>
  );
}

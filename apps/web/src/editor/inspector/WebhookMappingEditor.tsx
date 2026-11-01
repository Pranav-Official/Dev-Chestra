import { type Issue, WEBHOOK_HEADER_ALLOWLIST, type WorkflowParam } from "@devchestra/schema";
import { Plus, Trash2 } from "lucide-react";
import "../../styles/editor-webhook.css";

const BODY_PREFIX = "body.";
const HEADER_PREFIX = "headers.";

type Entry = [parameter: string, path: string];
type Source = "body" | "header";

/**
 * Looks up a validator issue for one mapping row. Pointers end in
 * `/webhook/paramMapping/<parameter>`, so the row's key is the match.
 */
function mappingIssue(issues: readonly Issue[], parameter: string, code: string): string | null {
  const suffix = `/webhook/paramMapping/${parameter}`;
  const found = issues.filter(
    (issue) =>
      issue.code === code &&
      typeof issue.pointer === "string" &&
      (issue.pointer === suffix || issue.pointer.endsWith(suffix)),
  );
  return found.length === 0 ? null : found.map((issue) => issue.message).join(" ");
}

function replaceAt(entries: readonly Entry[], index: number, next: Entry): Entry[] {
  return entries.map((entry, at) => (at === index ? next : entry));
}

/**
 * Edits `start.webhook.paramMapping`: one row per entry, keyed by parameter
 * name. An empty mapping is written as an absent key, because a present one
 * is authoritative (unmapped parameters would then read nothing).
 */
export function WebhookMappingEditor({
  params,
  mapping,
  issues,
  onChange,
}: {
  params: readonly WorkflowParam[];
  mapping: Readonly<Record<string, string>>;
  issues: readonly Issue[];
  onChange: (next: Record<string, string> | undefined) => void;
}) {
  const entries = Object.entries(mapping);
  const declared = params.map((param) => param.name);
  const mapped = new Set(entries.map(([name]) => name));
  const nextUnmapped = declared.find((name) => !mapped.has(name));

  const save = (next: Entry[]): void => {
    onChange(next.length === 0 ? undefined : Object.fromEntries(next));
  };

  return (
    <div className="webhook-mapping" data-testid="inspector-webhook-mapping">
      <p className="inspector-help">
        Each row reads one parameter from the delivery. Body paths are relative to the JSON body.
        Headers come from a fixed list. With no rows, each parameter reads{" "}
        <span className="mono">body.&lt;name&gt;</span>. Once there is a row, parameters without one
        take their default or fail as missing.
      </p>
      {entries.length === 0 ? (
        <p className="inspector-muted">No rows yet. Every parameter reads its body field.</p>
      ) : (
        <div className="webhook-mapping-list">
          {entries.map(([name, path], index) => (
            <MappingRow
              // biome-ignore lint/suspicious/noArrayIndexKey: mapping rows have no id; a renamed parameter must not remount the focused select
              key={index}
              index={index}
              parameter={name}
              path={path}
              declared={declared}
              taken={entries.filter((_, at) => at !== index).map(([other]) => other)}
              issues={issues}
              onParameter={(next) => save(replaceAt(entries, index, [next, path] as Entry))}
              onPath={(next) => save(replaceAt(entries, index, [name, next] as Entry))}
              onRemove={() => save(entries.filter((_, at) => at !== index))}
            />
          ))}
        </div>
      )}
      <button
        type="button"
        className="btn sm"
        data-testid="inspector-webhook-mapping-add"
        disabled={nextUnmapped === undefined}
        onClick={() => {
          if (nextUnmapped !== undefined) {
            save([...entries, [nextUnmapped, `${BODY_PREFIX}${nextUnmapped}`]]);
          }
        }}
      >
        <Plus size={13} aria-hidden="true" />
        Add mapping
      </button>
      {declared.length === 0 ? (
        <p className="inspector-muted">Declare a parameter above to map it.</p>
      ) : null}
    </div>
  );
}

function MappingRow({
  index,
  parameter,
  path,
  declared,
  taken,
  issues,
  onParameter,
  onPath,
  onRemove,
}: {
  index: number;
  parameter: string;
  path: string;
  declared: readonly string[];
  /** Parameter names other rows already map, which this row may not choose. */
  taken: readonly string[];
  issues: readonly Issue[];
  onParameter: (next: string) => void;
  onPath: (next: string) => void;
  onRemove: () => void;
}) {
  const label = index + 1;
  const source: Source = path.startsWith(HEADER_PREFIX) ? "header" : "body";
  const bodyPath =
    source === "body" ? (path.startsWith(BODY_PREFIX) ? path.slice(BODY_PREFIX.length) : path) : "";
  const header = source === "header" ? path.slice(HEADER_PREFIX.length) : "";
  const parameterError = mappingIssue(issues, parameter, "E_WEBHOOK_MAPPING");
  const pathError = mappingIssue(issues, parameter, "E_WEBHOOK_PATH");
  // A key that is no longer declared stays selectable, so the row can show and fix it.
  const options = declared.includes(parameter) ? declared : [parameter, ...declared];
  const parameterId = `inspector-webhook-mapping-${index}-parameter`;

  return (
    <fieldset className="webhook-mapping-row" data-testid={`inspector-webhook-mapping-${index}`}>
      <legend className="sr-only">Mapping {label}</legend>
      <div className="webhook-mapping-head">
        <select
          id={parameterId}
          className="inspector-input"
          data-testid={parameterId}
          aria-label={`Parameter for mapping ${label}`}
          aria-invalid={parameterError ? true : undefined}
          value={parameter}
          onChange={(event) => onParameter(event.currentTarget.value)}
        >
          {options.map((option) => (
            <option key={option} value={option} disabled={taken.includes(option)}>
              {declared.includes(option) ? option : `${option} (not declared)`}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn ghost sm danger"
          aria-label={`Remove mapping ${label}`}
          data-testid={`inspector-webhook-mapping-${index}-remove`}
          onClick={onRemove}
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
      {parameterError ? (
        <p className="inspector-error" role="alert">
          {parameterError}
        </p>
      ) : null}

      <div className="webhook-mapping-path">
        <select
          className="inspector-input"
          aria-label={`Source for mapping ${label}`}
          data-testid={`inspector-webhook-mapping-${index}-source`}
          value={source}
          onChange={(event) =>
            onPath(
              event.currentTarget.value === "header"
                ? `${HEADER_PREFIX}${WEBHOOK_HEADER_ALLOWLIST[0] ?? ""}`
                : `${BODY_PREFIX}${parameter}`,
            )
          }
        >
          <option value="body">Body</option>
          <option value="header">Header</option>
        </select>
        {source === "body" ? (
          <span className="webhook-mapping-prefix">
            <span className="mono faint">body.</span>
            <input
              className="inspector-input"
              type="text"
              aria-label={`Body path for mapping ${label}`}
              aria-invalid={pathError ? true : undefined}
              data-testid={`inspector-webhook-mapping-${index}-path`}
              value={bodyPath}
              // Paths never contain whitespace, so a stray or pasted space is removed here
              // rather than left to fail validation as "body. name".
              onChange={(event) =>
                onPath(`${BODY_PREFIX}${event.currentTarget.value.replace(/\s+/gu, "")}`)
              }
            />
          </span>
        ) : (
          <select
            className="inspector-input"
            aria-label={`Header for mapping ${label}`}
            aria-invalid={pathError ? true : undefined}
            data-testid={`inspector-webhook-mapping-${index}-header`}
            value={header}
            onChange={(event) => onPath(`${HEADER_PREFIX}${event.currentTarget.value}`)}
          >
            <option value="" disabled>
              Choose a header
            </option>
            {WEBHOOK_HEADER_ALLOWLIST.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        )}
      </div>
      {pathError ? (
        <p className="inspector-error" role="alert">
          {pathError}
        </p>
      ) : null}
    </fieldset>
  );
}

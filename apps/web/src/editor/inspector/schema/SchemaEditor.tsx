import { isRecord } from "@devchestra/core";
import type { Issue, JsonSchemaObject } from "@devchestra/schema";
import { normalizeOutputSchema } from "@devchestra/schema";
import { AlertCircle, Braces, Code, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useBufferFlag } from "../BufferContext.js";
import { CheckboxField, describedBy, Field } from "../fields/fields.js";
import { useBufferedNumber } from "../fields/useBufferedNumber.js";
import { useBufferedText } from "../fields/useBufferedText.js";
import { containingIssue } from "../issues.js";
import {
  buildSchema,
  canUseBasicRoot,
  createRow,
  createStructuredScaffold,
  DEFAULT_MAX_ITEMS,
  isRawRoot,
  nextPropertyName,
  PROPERTY_KINDS,
  type PropertyKind,
  RAW_OBJECT_SCHEMA,
  readRows,
  rowsProblem,
  type SchemaRow,
  schemaSignature,
} from "./schemaModel.js";

function pretty(schema: JsonSchemaObject): string {
  return JSON.stringify(schema, null, 2);
}

type Parsed = { ok: true; value: JsonSchemaObject } | { ok: false; reason: string };

function parseSchemaJson(text: string): Parsed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `Invalid JSON: ${(error as Error).message}` };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: "Output schema must be a JSON object." };
  }
  return { ok: true, value: parsed };
}

function ArrayBounds({
  row,
  index,
  onChange,
}: {
  row: SchemaRow;
  index: number;
  onChange: (patch: Partial<SchemaRow>) => void;
}) {
  const max = useBufferedNumber(row.maxItems, {
    label: `Property ${index + 1} maxItems`,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    allowEmpty: false,
    onCommit: (value) => onChange({ maxItems: value }),
    bufferKey: `output.row.${row.uid}.maxItems`,
  });
  const min = useBufferedNumber(row.minItems, {
    label: `Property ${index + 1} minItems`,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    allowEmpty: true,
    onCommit: (value) => onChange({ minItems: value }),
    bufferKey: `output.row.${row.uid}.minItems`,
  });
  const maxId = `inspector-output-row-${index}-max-items`;
  const minId = `inspector-output-row-${index}-min-items`;
  return (
    <div className="inspector-grid-2">
      <Field id={maxId} label="Max items" required error={max.localError}>
        <input
          id={maxId}
          className="inspector-input"
          data-testid={maxId}
          type="text"
          inputMode="numeric"
          value={max.text}
          aria-invalid={max.localError ? true : undefined}
          aria-describedby={describedBy(maxId, undefined, max.localError)}
          onChange={(event) => max.onChange(event.currentTarget.value)}
        />
      </Field>
      <Field id={minId} label="Min items" error={min.localError}>
        <input
          id={minId}
          className="inspector-input"
          data-testid={minId}
          type="text"
          inputMode="numeric"
          value={min.text}
          aria-invalid={min.localError ? true : undefined}
          aria-describedby={describedBy(minId, undefined, min.localError)}
          onChange={(event) => min.onChange(event.currentTarget.value)}
        />
      </Field>
    </div>
  );
}

function SchemaRowEditor({
  row,
  index,
  onChange,
  onRemove,
}: {
  row: SchemaRow;
  index: number;
  onChange: (patch: Partial<SchemaRow>) => void;
  onRemove: () => void;
}) {
  const name = useBufferedText(
    row.name,
    (next) => (next === "" ? "Property name is required." : null),
    (next) => onChange({ name: next }),
    `output.row.${row.uid}.name`,
  );
  const nameId = `inspector-output-row-${index}-name`;
  const typeId = `inspector-output-row-${index}-type`;
  const descriptionId = `inspector-output-row-${index}-description`;
  const nameError = name.localError;
  const typeValue =
    row.complex && !PROPERTY_KINDS.some((kind) => kind.value === row.kind) ? "advanced" : row.kind;

  return (
    <fieldset className="inspector-schema-row" data-testid={`inspector-output-row-${index}`}>
      <legend className="sr-only">Output property {index + 1}</legend>
      <div className="inspector-row-head">
        <span className="inspector-row-title">Property {index + 1}</span>
        <button
          type="button"
          className="btn ghost sm danger"
          data-testid={`inspector-output-row-${index}-remove`}
          aria-label={`Remove property ${index + 1}`}
          onClick={onRemove}
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
      <Field id={nameId} label="Property name" required error={nameError}>
        <input
          id={nameId}
          className="inspector-input"
          data-testid={nameId}
          type="text"
          value={name.text}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={describedBy(nameId, undefined, nameError)}
          onChange={(event) => name.onChange(event.currentTarget.value)}
        />
      </Field>
      <div className="inspector-grid-2">
        <Field id={typeId} label="Type">
          <select
            id={typeId}
            className="inspector-input"
            data-testid={typeId}
            value={typeValue}
            disabled={row.complex}
            onChange={(event) => onChange({ kind: event.currentTarget.value as PropertyKind })}
          >
            {PROPERTY_KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
            {typeValue === "advanced" ? <option value="advanced">Advanced</option> : null}
          </select>
        </Field>
        <div className="inspector-check-align">
          <CheckboxField
            id={`inspector-output-row-${index}-required`}
            label="Required"
            checked={row.required}
            onChange={(required) => onChange({ required })}
          />
        </div>
      </div>
      <Field id={descriptionId} label="Description">
        <input
          id={descriptionId}
          className="inspector-input"
          data-testid={descriptionId}
          type="text"
          value={row.description}
          onChange={(event) =>
            onChange({ description: event.currentTarget.value, descriptionDirty: true })
          }
        />
      </Field>
      {row.kind === "arrayStrings" ? (
        <ArrayBounds row={row} index={index} onChange={onChange} />
      ) : null}
      {row.complex ? (
        <p className="inspector-note" role="note">
          <Braces size={13} aria-hidden="true" />
          <span>
            Advanced or nested schema keywords are preserved. Use Edit JSON to change them without
            losing them.
          </span>
        </p>
      ) : null}
    </fieldset>
  );
}

type RootMode = "raw" | "structured";

export function SchemaEditor({
  schema,
  issues,
  onPatch,
}: {
  schema: JsonSchemaObject;
  issues: readonly Issue[];
  onPatch: (output: JsonSchemaObject) => void;
}) {
  const modeName = useId();
  const [rootMode, setRootMode] = useState<RootMode>(() =>
    isRawRoot(schema) ? "raw" : "structured",
  );
  const [view, setView] = useState<"basic" | "advanced">(() =>
    canUseBasicRoot(schema) ? "basic" : "advanced",
  );
  const [rows, setRows] = useState<SchemaRow[]>(() => readRows(schema));
  const [advancedText, setAdvancedText] = useState(() => pretty(schema));
  const [advancedError, setAdvancedError] = useState<string | null>(null);
  const [structuredNote, setStructuredNote] = useState<string | null>(null);
  const base = useRef(schema);
  const lastEmitted = useRef(schemaSignature(schema));
  const lastSeen = useRef(schemaSignature(schema));
  const cachedStructured = useRef<JsonSchemaObject | null>(null);

  useEffect(() => {
    const signature = schemaSignature(schema);
    if (signature === lastSeen.current) return;
    lastSeen.current = signature;
    if (signature === lastEmitted.current) return;
    const raw = isRawRoot(schema);
    base.current = schema;
    setRows(readRows(schema));
    setAdvancedText(pretty(schema));
    setAdvancedError(null);
    setStructuredNote(null);
    setRootMode(raw ? "raw" : "structured");
    setView(canUseBasicRoot(schema) ? "basic" : "advanced");
    if (!raw) cachedStructured.current = schema;
  }, [schema]);

  const rowsError = rowsProblem(rows);
  const structured = rootMode === "structured";
  useBufferFlag("output.rows", structured && view === "basic" ? rowsError : null);
  useBufferFlag("output.advanced", structured && view === "advanced" ? advancedError : null);

  const basicAllowed = canUseBasicRoot(schema);
  const schemaCheck = useMemo(() => normalizeOutputSchema(schema), [schema]);
  const schemaIssue = schemaCheck.ok ? null : schemaCheck.error.message;
  const outputIssue = containingIssue(issues, "/output");
  const rootIsObject = schema.type === "object";

  const commitRows = (nextRows: SchemaRow[]): void => {
    setRows(nextRows);
    if (rowsProblem(nextRows) !== null) return;
    const built = buildSchema(base.current, nextRows);
    base.current = built;
    lastEmitted.current = schemaSignature(built);
    onPatch(built);
  };

  const changeRow = (uid: string, patch: Partial<SchemaRow>): void => {
    commitRows(
      rows.map((entry) => {
        if (entry.uid !== uid) return entry;
        const merged = { ...entry, ...patch };
        if (patch.kind !== undefined && patch.kind !== entry.kind) {
          if (patch.kind === "arrayStrings") {
            merged.maxItems = merged.maxItems ?? DEFAULT_MAX_ITEMS;
          } else {
            merged.maxItems = undefined;
            merged.minItems = undefined;
          }
        }
        return merged;
      }),
    );
  };

  const applyAdvanced = (text: string): void => {
    setAdvancedText(text);
    const parsed = parseSchemaJson(text);
    if (!parsed.ok) {
      setAdvancedError(parsed.reason);
      return;
    }
    setAdvancedError(null);
    base.current = parsed.value;
    lastEmitted.current = schemaSignature(parsed.value);
    setRows(readRows(parsed.value));
    onPatch(parsed.value);
  };

  const switchView = (next: "basic" | "advanced"): void => {
    if (next === "advanced") {
      setAdvancedText(pretty(schema));
      setAdvancedError(null);
      setView("advanced");
      return;
    }
    base.current = schema;
    lastEmitted.current = schemaSignature(schema);
    setRows(readRows(schema));
    setAdvancedText(pretty(schema));
    setAdvancedError(null);
    setView("basic");
  };

  const switchToRaw = (): void => {
    if (rootMode === "raw") return;
    if (!isRawRoot(schema)) cachedStructured.current = schema;
    setRootMode("raw");
    setStructuredNote(null);
    setAdvancedError(null);
    const raw = { ...RAW_OBJECT_SCHEMA };
    base.current = raw;
    lastEmitted.current = schemaSignature(raw);
    onPatch(raw);
  };

  const switchToStructured = (): void => {
    if (rootMode === "structured") return;
    const cached =
      cachedStructured.current === null || isRawRoot(cachedStructured.current)
        ? null
        : cachedStructured.current;
    const target = cached ?? createStructuredScaffold();
    setRootMode("structured");
    setStructuredNote(
      cached === null
        ? "No previous structured schema was cached; added the strict summary/points starter fields."
        : "Restored the previous structured schema for this node.",
    );
    setAdvancedError(null);
    base.current = target;
    lastEmitted.current = schemaSignature(target);
    setRows(readRows(target));
    setAdvancedText(pretty(target));
    setView(canUseBasicRoot(target) ? "basic" : "advanced");
    onPatch(target);
  };

  return (
    <div className="inspector-stack">
      <fieldset className="inspector-fieldset" data-testid="inspector-output-mode">
        <legend className="sr-only">Output mode</legend>
        <div className="inspector-segmented">
          <label>
            <input
              type="radio"
              name={modeName}
              checked={rootMode === "raw"}
              data-testid="inspector-output-mode-raw"
              onChange={switchToRaw}
            />
            <span>Raw JSON</span>
          </label>
          <label>
            <input
              type="radio"
              name={modeName}
              checked={rootMode === "structured"}
              data-testid="inspector-output-mode-structured"
              onChange={switchToStructured}
            />
            <span>Structured</span>
          </label>
        </div>
      </fieldset>
      {rootIsObject ? null : (
        <p className="inspector-note amber" data-testid="inspector-output-root-caption" role="note">
          <span>
            submit_result arguments must be a JSON object. To return a scalar or array, add an Any
            field named <span className="mono">value</span> and submit{" "}
            <span className="mono">{'{ "value": ... }'}</span>.
          </span>
        </p>
      )}
      {rootMode === "raw" ? (
        <>
          <p className="inspector-note" data-testid="inspector-output-raw-note" role="note">
            Return any JSON object. Any keys and JSON values are allowed, including empty objects.
            Raw output does not verify task quality.
          </p>
          <details className="inspector-json-view">
            <summary data-testid="inspector-output-view-json">View JSON Schema</summary>
            <pre className="inspector-code">{pretty(schema)}</pre>
          </details>
        </>
      ) : (
        <>
          {structuredNote === null ? null : (
            <p
              className="inspector-note"
              data-testid="inspector-output-structured-note"
              role="note"
            >
              {structuredNote}
            </p>
          )}
          {!rootIsObject || basicAllowed === false ? (
            <div className="inspector-note amber" role="note">
              <div>
                <b>Advanced output schema</b>
                <p>
                  The basic row editor cannot represent this schema. The JSON below is preserved as
                  a whole; edit it only if you intend to replace that structure.
                </p>
              </div>
            </div>
          ) : null}
          {view === "basic" ? (
            <>
              <div className="inspector-schema-list">
                {rows.length === 0 ? (
                  <p className="inspector-muted">
                    No output properties yet. Add fields, or switch to Raw JSON object to accept
                    arbitrary keys.
                  </p>
                ) : (
                  rows.map((entry, index) => (
                    <SchemaRowEditor
                      key={entry.uid}
                      row={entry}
                      index={index}
                      onChange={(patch) => changeRow(entry.uid, patch)}
                      onRemove={() =>
                        commitRows(rows.filter((candidate) => candidate.uid !== entry.uid))
                      }
                    />
                  ))
                )}
              </div>
              {rootIsObject && rows.length === 0 && schema.additionalProperties !== true ? (
                <p
                  className="inspector-note amber"
                  data-testid="inspector-output-closed-hint"
                  role="note"
                >
                  This is a closed object with no fields. Existing strict schemas are unchanged.
                  Choose Raw JSON object to accept arbitrary keys, or add an Any field named value
                  to return a scalar or array.
                </p>
              ) : null}
              <div className="inspector-inline">
                <button
                  type="button"
                  className="btn sm"
                  data-testid="inspector-output-add-property"
                  onClick={() => commitRows([...rows, createRow("string", nextPropertyName(rows))])}
                >
                  <Plus size={13} aria-hidden="true" />
                  Add property
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  data-testid="inspector-output-advanced-toggle"
                  onClick={() => switchView("advanced")}
                >
                  <Code size={13} aria-hidden="true" />
                  Edit JSON
                </button>
              </div>
              <details className="inspector-json-view">
                <summary data-testid="inspector-output-view-json">View JSON Schema</summary>
                <pre className="inspector-code">{pretty(schema)}</pre>
              </details>
            </>
          ) : (
            <>
              <Field
                id="inspector-output-advanced-json"
                label="Output JSON Schema"
                help="Applied only while the text parses to a JSON object. Invalid JSON blocks Save and Run."
                error={advancedError}
              >
                <textarea
                  id="inspector-output-advanced-json"
                  className="inspector-input inspector-textarea inspector-code-input"
                  data-testid="inspector-output-advanced-json"
                  rows={14}
                  spellCheck={false}
                  value={advancedText}
                  aria-invalid={advancedError ? true : undefined}
                  aria-describedby={describedBy(
                    "inspector-output-advanced-json",
                    undefined,
                    advancedError,
                  )}
                  onChange={(event) => applyAdvanced(event.currentTarget.value)}
                />
              </Field>
              <div className="inspector-inline">
                {basicAllowed ? (
                  <button
                    type="button"
                    className="btn sm"
                    data-testid="inspector-output-basic-toggle"
                    onClick={() => switchView("basic")}
                  >
                    Basic rows
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => applyAdvanced(pretty(schema))}
                >
                  Reset to current schema
                </button>
              </div>
            </>
          )}
        </>
      )}
      {schemaIssue ? (
        <p className="inspector-error" role="alert" data-testid="inspector-output-schema-error">
          <AlertCircle size={12} aria-hidden="true" />
          <span>{schemaIssue}</span>
        </p>
      ) : null}
      {outputIssue && outputIssue !== schemaIssue ? (
        <p className="inspector-error" role="alert">
          {outputIssue}
        </p>
      ) : null}
    </div>
  );
}

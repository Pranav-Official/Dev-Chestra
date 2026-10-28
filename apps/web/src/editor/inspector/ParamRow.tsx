import type { Issue, ParamType, WorkflowParam } from "@devchestra/schema";
import { Plus, Trash2 } from "lucide-react";
import { useBufferFlag } from "./BufferContext.js";
import { CheckboxField, describedBy, Field } from "./fields/fields.js";
import { useBufferedNumber } from "./fields/useBufferedNumber.js";
import { useBufferedText } from "./fields/useBufferedText.js";
import { fieldIssue } from "./issues.js";

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const INVALID_DEFAULT = "\u0000invalid";

const TYPES: readonly { value: ParamType; label: string }[] = [
  { value: "string", label: "String" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Boolean" },
  { value: "enum", label: "Enum" },
];

function defaultCompatible(value: WorkflowParam["default"], type: ParamType): boolean {
  if (value === undefined) return false;
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  return typeof value === "string";
}

function withDefault(param: WorkflowParam, value: WorkflowParam["default"]): WorkflowParam {
  const next: WorkflowParam = { ...param };
  if (value === undefined) delete next.default;
  else next.default = value as string | number | boolean;
  return next;
}

function changeType(param: WorkflowParam, type: ParamType): WorkflowParam {
  const next: WorkflowParam = { name: param.name, type, required: param.required };
  if (type === "enum") {
    const options =
      param.options !== undefined && param.options.length > 0 ? [...param.options] : ["option1"];
    next.options = options;
    if (typeof param.default === "string" && options.includes(param.default)) {
      next.default = param.default;
    }
  } else if (defaultCompatible(param.default, type)) {
    next.default = param.default as string | number | boolean;
  }
  return next;
}

function StringDefault({
  param,
  index,
  issues,
  onChange,
}: {
  param: WorkflowParam;
  index: number;
  issues: readonly Issue[];
  onChange: (next: WorkflowParam) => void;
}) {
  const invalid =
    param.default !== undefined && typeof param.default !== "string"
      ? "Default must be a string."
      : null;
  useBufferFlag(`param.${index}.stringDefault`, invalid);
  const issue = fieldIssue(issues, `/params/${index}/default`);
  const error = invalid ?? issue;
  const id = `inspector-param-${index}-default`;
  return (
    <Field
      id={id}
      label="Default (optional)"
      help="Blank is a valid string default; use Clear to remove the default entirely."
      error={error}
    >
      <div className="inspector-inline">
        <input
          id={id}
          className="inspector-input"
          data-testid={id}
          type="text"
          value={typeof param.default === "string" ? param.default : ""}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, undefined, error)}
          onChange={(event) => onChange(withDefault(param, event.currentTarget.value))}
        />
        {param.default === undefined ? null : (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => onChange(withDefault(param, undefined))}
          >
            Clear
          </button>
        )}
      </div>
    </Field>
  );
}

function NumberDefault({
  param,
  index,
  issues,
  onChange,
}: {
  param: WorkflowParam;
  index: number;
  issues: readonly Issue[];
  onChange: (next: WorkflowParam) => void;
}) {
  const rawInvalid =
    param.default !== undefined &&
    (typeof param.default !== "number" || !Number.isFinite(param.default))
      ? "Default must be a finite number."
      : null;
  useBufferFlag(`param.${index}.numberDefaultRaw`, rawInvalid);
  const numeric = useBufferedNumber(
    typeof param.default === "number" && Number.isFinite(param.default) ? param.default : undefined,
    {
      label: `Parameter ${index + 1} default`,
      min: Number.NEGATIVE_INFINITY,
      max: Number.POSITIVE_INFINITY,
      integer: false,
      allowEmpty: true,
      onCommit: (value) => onChange(withDefault(param, value)),
      bufferKey: `param.${index}.numberDefault`,
    },
  );
  const issue = fieldIssue(issues, `/params/${index}/default`);
  const error = rawInvalid ?? numeric.localError ?? issue;
  const id = `inspector-param-${index}-default`;
  return (
    <Field id={id} label="Default (optional)" help="Blank means no default." error={error}>
      <input
        id={id}
        className="inspector-input"
        data-testid={id}
        type="text"
        inputMode="decimal"
        value={numeric.text}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, undefined, error)}
        onChange={(event) => numeric.onChange(event.currentTarget.value)}
      />
    </Field>
  );
}

function BooleanDefault({
  param,
  index,
  issues,
  onChange,
}: {
  param: WorkflowParam;
  index: number;
  issues: readonly Issue[];
  onChange: (next: WorkflowParam) => void;
}) {
  const invalid =
    param.default !== undefined && typeof param.default !== "boolean"
      ? "Default must be true or false."
      : null;
  useBufferFlag(`param.${index}.booleanDefault`, invalid);
  const issue = fieldIssue(issues, `/params/${index}/default`);
  const error = invalid ?? issue;
  const id = `inspector-param-${index}-default`;
  const value =
    param.default === true ? "true" : param.default === false ? "false" : invalid ? "invalid" : "";
  return (
    <Field id={id} label="Default (optional)" error={error}>
      <select
        id={id}
        className="inspector-input"
        data-testid={id}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, undefined, error)}
        onChange={(event) => {
          const next = event.currentTarget.value;
          onChange(withDefault(param, next === "" ? undefined : next === "true"));
        }}
      >
        <option value="">No default</option>
        <option value="true">true</option>
        <option value="false">false</option>
        {invalid ? (
          <option value="invalid" disabled>
            Invalid value
          </option>
        ) : null}
      </select>
    </Field>
  );
}

function EnumDefault({
  param,
  index,
  issues,
  onChange,
}: {
  param: WorkflowParam;
  index: number;
  issues: readonly Issue[];
  onChange: (next: WorkflowParam) => void;
}) {
  const options = param.options ?? [];
  const invalid =
    param.default !== undefined &&
    (typeof param.default !== "string" || !options.includes(param.default))
      ? "Default must be one of the options, or choose No default."
      : null;
  useBufferFlag(`param.${index}.enumDefault`, invalid);
  const issue = fieldIssue(issues, `/params/${index}/default`);
  const error = invalid ?? issue;
  const id = `inspector-param-${index}-default`;
  const current = typeof param.default === "string" ? param.default : undefined;
  const value = invalid ? INVALID_DEFAULT : (current ?? "");
  return (
    <Field id={id} label="Default (optional)" error={error}>
      <select
        id={id}
        className="inspector-input"
        data-testid={id}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, undefined, error)}
        onChange={(event) => {
          const next = event.currentTarget.value;
          onChange(withDefault(param, next === "" ? undefined : next));
        }}
      >
        <option value="">No default</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
        {invalid ? (
          <option value={INVALID_DEFAULT} disabled>
            Invalid: {String(param.default)}
          </option>
        ) : null}
      </select>
    </Field>
  );
}

function OptionsEditor({
  param,
  index,
  issues,
  onChange,
}: {
  param: WorkflowParam;
  index: number;
  issues: readonly Issue[];
  onChange: (next: WorkflowParam) => void;
}) {
  const options = param.options ?? [];
  const issue = fieldIssue(issues, `/params/${index}/options`);
  const setOptions = (next: string[]): void => onChange({ ...param, options: next });
  return (
    <div className="inspector-field">
      <span className="inspector-label" id={`inspector-param-${index}-options-label`}>
        Options
      </span>
      <fieldset
        className="inspector-option-list"
        aria-labelledby={`inspector-param-${index}-options-label`}
        data-testid={`inspector-param-${index}-options`}
      >
        <legend className="sr-only">Options</legend>
        {options.map((option, optionIndex) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: enum options are plain strings with no id; changing the value must not remount the focused input
          <div className="inspector-inline" key={`${optionIndex}:${option}`}>
            <input
              className="inspector-input"
              data-testid={`inspector-param-${index}-option-${optionIndex}`}
              aria-label={`Option ${optionIndex + 1} for parameter ${index + 1}`}
              type="text"
              value={option}
              onChange={(event) =>
                setOptions(
                  options.map((entry, at) =>
                    at === optionIndex ? event.currentTarget.value : entry,
                  ),
                )
              }
            />
            <button
              type="button"
              className="btn ghost sm"
              aria-label={`Remove option ${optionIndex + 1} for parameter ${index + 1}`}
              onClick={() => setOptions(options.filter((_, at) => at !== optionIndex))}
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </div>
        ))}
      </fieldset>
      <button
        type="button"
        className="btn ghost sm"
        data-testid={`inspector-param-${index}-option-add`}
        onClick={() => setOptions([...options, ""])}
      >
        <Plus size={12} aria-hidden="true" />
        Add option
      </button>
      {issue ? (
        <p className="inspector-error" role="alert">
          {issue}
        </p>
      ) : null}
    </div>
  );
}

export function ParamRow({
  param,
  index,
  issues,
  onChange,
  onRemove,
}: {
  param: WorkflowParam;
  index: number;
  issues: readonly Issue[];
  onChange: (next: WorkflowParam) => void;
  onRemove: () => void;
}) {
  const name = useBufferedText(
    param.name,
    (next) => {
      if (!PARAM_NAME.test(next)) {
        return "Use letters, numbers and underscores; start with a letter or underscore (max 64).";
      }
      return null;
    },
    (next) => onChange({ ...param, name: next }),
    `param.${index}.name`,
  );
  const nameIssue = fieldIssue(issues, `/params/${index}/name`);
  const nameError = name.localError ?? nameIssue;
  const typeIssue = fieldIssue(issues, `/params/${index}/type`);
  const requiredIssue = fieldIssue(issues, `/params/${index}/required`);
  const nameId = `inspector-param-${index}-name`;
  const typeId = `inspector-param-${index}-type`;

  return (
    <fieldset className="inspector-param" data-testid={`inspector-param-${index}`}>
      <legend className="sr-only">Parameter {index + 1}</legend>
      <div className="inspector-row-head">
        <span className="inspector-row-title">Parameter {index + 1}</span>
        <button
          type="button"
          className="btn ghost sm danger"
          data-testid={`inspector-param-${index}-remove`}
          aria-label={`Remove parameter ${index + 1}`}
          onClick={onRemove}
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
      <Field id={nameId} label="Name" required help="JSONata-safe: no hyphens." error={nameError}>
        <input
          id={nameId}
          className="inspector-input"
          data-testid={nameId}
          type="text"
          value={name.text}
          maxLength={64}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={describedBy(nameId, "JSONata-safe: no hyphens.", nameError)}
          onChange={(event) => name.onChange(event.currentTarget.value)}
        />
      </Field>
      <div className="inspector-grid-2">
        <Field id={typeId} label="Type" error={typeIssue}>
          <select
            id={typeId}
            className="inspector-input"
            data-testid={typeId}
            value={param.type}
            onChange={(event) =>
              onChange(changeType(param, event.currentTarget.value as ParamType))
            }
          >
            {TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="inspector-check-align">
          <CheckboxField
            id={`inspector-param-${index}-required`}
            label="Required"
            checked={param.required}
            error={requiredIssue}
            onChange={(required) => onChange({ ...param, required })}
          />
        </div>
      </div>
      {param.type === "string" ? (
        <StringDefault param={param} index={index} issues={issues} onChange={onChange} />
      ) : null}
      {param.type === "number" ? (
        <NumberDefault param={param} index={index} issues={issues} onChange={onChange} />
      ) : null}
      {param.type === "boolean" ? (
        <BooleanDefault param={param} index={index} issues={issues} onChange={onChange} />
      ) : null}
      {param.type === "enum" ? (
        <>
          <EnumDefault param={param} index={index} issues={issues} onChange={onChange} />
          <OptionsEditor param={param} index={index} issues={issues} onChange={onChange} />
        </>
      ) : null}
    </fieldset>
  );
}

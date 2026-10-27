import type { AgentNode, Issue, AgentLimits as Limits } from "@relay/schema";
import { useBufferFlag } from "./BufferContext.js";
import { describedBy, Field } from "./fields/fields.js";
import { useBufferedNumber } from "./fields/useBufferedNumber.js";
import { fieldIssue } from "./issues.js";
import type { PatchOf } from "./types.js";

type LimitKey = "timeoutMin" | "validationRetries" | "crashRetries";

function withLimit(node: AgentNode, key: LimitKey, value: number | undefined): PatchOf<AgentNode> {
  const limits: Limits = { ...(node.limits ?? {}) };
  if (value === undefined) delete limits[key];
  else limits[key] = value;
  return { limits: Object.keys(limits).length === 0 ? undefined : limits };
}

function LimitField({
  node,
  issues,
  onPatch,
  fieldKey,
  label,
  help,
  min,
  max,
}: {
  node: AgentNode;
  issues: readonly Issue[];
  onPatch: (patch: PatchOf<AgentNode>) => void;
  fieldKey: LimitKey;
  label: string;
  help: string;
  min: number;
  max: number;
}) {
  const stored = node.limits?.[fieldKey];
  const rawInvalid =
    stored !== undefined && (!Number.isSafeInteger(stored) || stored < min || stored > max)
      ? `${label} is outside the engine range.`
      : null;
  useBufferFlag(`agent.limits.${fieldKey}.raw`, rawInvalid);
  const field = useBufferedNumber(typeof stored === "number" ? stored : undefined, {
    label,
    min,
    max,
    allowEmpty: true,
    onCommit: (value) => onPatch(withLimit(node, fieldKey, value)),
    bufferKey: `agent.limits.${fieldKey}`,
  });
  const issue = fieldIssue(issues, `/limits/${fieldKey}`);
  const error = rawInvalid ?? field.localError ?? issue;
  const id = `inspector-agent-${fieldKey === "timeoutMin" ? "timeout" : fieldKey.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  return (
    <Field id={id} label={label} help={help} error={error}>
      <input
        id={id}
        className="inspector-input"
        data-testid={id}
        type="text"
        inputMode="numeric"
        value={field.text}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, help, error)}
        onChange={(event) => field.onChange(event.currentTarget.value)}
      />
    </Field>
  );
}

export function AgentLimits({
  node,
  issues,
  onPatch,
}: {
  node: AgentNode;
  issues: readonly Issue[];
  onPatch: (patch: PatchOf<AgentNode>) => void;
}) {
  return (
    <div className="inspector-stack">
      <LimitField
        node={node}
        issues={issues}
        onPatch={onPatch}
        fieldKey="timeoutMin"
        label="Timeout (minutes)"
        help="Engine default 30; allowed 1–480. Blank uses the default."
        min={1}
        max={480}
      />
      <LimitField
        node={node}
        issues={issues}
        onPatch={onPatch}
        fieldKey="validationRetries"
        label="Validation retries"
        help="Engine default 2; allowed 0–10. Blank uses the default."
        min={0}
        max={10}
      />
      <LimitField
        node={node}
        issues={issues}
        onPatch={onPatch}
        fieldKey="crashRetries"
        label="Crash retries"
        help="Engine default 1; allowed 0–10. Blank uses the default."
        min={0}
        max={10}
      />
    </div>
  );
}

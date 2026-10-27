import { type GateNode, MAX_GATE_BRANCHES } from "@relay/schema";
import { AlertCircle, CheckCircle2, PlayCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { workflowApi } from "../api/workflowApi.js";
import { describedBy, Field } from "./fields/fields.js";

export interface GateTestEvaluation {
  branch: string;
  matched: boolean;
  error?: string;
}

export interface GateTestResultLike {
  branch: string | null;
  evaluated: GateTestEvaluation[];
  error?: { code: string; message: string };
}

export type GateTestRunner = (
  gate: GateNode,
  scope: Record<string, unknown>,
) => Promise<GateTestResultLike>;

export const MAX_SCOPE_BYTES = 32 * 1024;
export const MAX_GATE_BODY_BYTES = 64 * 1024;
export const MAX_BRANCHES = MAX_GATE_BRANCHES;
export const MAX_EXPRESSION_BYTES = 4 * 1024;

function bytes(value: string): number {
  return typeof TextEncoder === "undefined" ? value.length : new TextEncoder().encode(value).length;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return "The gate test failed.";
}

function gateProblem(gate: GateNode): string | null {
  if (gate.branches.length === 0 || gate.branches.length > MAX_BRANCHES) {
    return `A gate needs 1–${MAX_BRANCHES} branches.`;
  }
  const otherwise = gate.branches.filter((branch) => branch.otherwise === true);
  if (otherwise.length !== 1 || gate.branches.at(-1)?.otherwise !== true) {
    return "A gate needs exactly one otherwise branch, and it must be last.";
  }
  for (const branch of gate.branches) {
    if (branch.otherwise === true) continue;
    if (branch.when === undefined || branch.when.trim() === "") {
      return `Branch '${branch.id}' needs a condition.`;
    }
    if (bytes(branch.when) > MAX_EXPRESSION_BYTES) {
      return `Branch '${branch.id}' exceeds ${MAX_EXPRESSION_BYTES} bytes.`;
    }
  }
  return null;
}

export function GateTester({
  node,
  projectId,
  runTest,
}: {
  node: GateNode;
  projectId?: string | undefined;
  runTest?: GateTestRunner | undefined;
}) {
  const [sample, setSample] = useState("{}");
  const [result, setResult] = useState<GateTestResultLike | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = `${projectId ?? ""}|${node.id}|${JSON.stringify(node.branches)}|${sample}`;
  const keyRef = useRef(key);
  const requestRef = useRef(0);

  useEffect(() => {
    keyRef.current = key;
    requestRef.current += 1;
    setResult(null);
    setBusy(false);
  }, [key]);

  const submit = async (): Promise<void> => {
    const problem = gateProblem(node);
    if (problem !== null) {
      setError(problem);
      return;
    }
    let scope: unknown;
    try {
      scope = JSON.parse(sample);
    } catch (parseError) {
      setError(`Sample scope is not valid JSON: ${messageOf(parseError)}`);
      return;
    }
    if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
      setError("Sample scope must be a JSON object.");
      return;
    }
    if (bytes(sample) > MAX_SCOPE_BYTES) {
      setError(`Sample scope exceeds ${MAX_SCOPE_BYTES} bytes.`);
      return;
    }
    const body = { gate: node, scope };
    if (bytes(JSON.stringify(body)) > MAX_GATE_BODY_BYTES) {
      setError(`The gate test request exceeds ${MAX_GATE_BODY_BYTES} bytes.`);
      return;
    }
    if (runTest === undefined && projectId === undefined) {
      setError("Open a saved project workflow to test a gate.");
      return;
    }
    const generation = requestRef.current + 1;
    requestRef.current = generation;
    const activeKey = key;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const runner: GateTestRunner =
        runTest ?? ((gate, value) => workflowApi.testGate(projectId ?? "", gate, value));
      const next = await runner(node, scope as Record<string, unknown>);
      if (keyRef.current !== activeKey || requestRef.current !== generation) return;
      setResult(next);
    } catch (testError) {
      if (keyRef.current !== activeKey || requestRef.current !== generation) return;
      setError(messageOf(testError));
    } finally {
      if (keyRef.current === activeKey && requestRef.current === generation) setBusy(false);
    }
  };

  const chosen = result?.branch ?? null;
  return (
    <div className="inspector-stack" data-testid="gate-tester">
      <Field
        id="gate-tester-scope"
        label="Sample scope (JSON)"
        help="Stateless preview only. Nothing runs, no model is called, and no run or file is written."
        error={error}
      >
        <textarea
          id="gate-tester-scope"
          className="inspector-input inspector-textarea inspector-code-input"
          data-testid="gate-tester-scope"
          rows={5}
          spellCheck={false}
          value={sample}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy("gate-tester-scope", undefined, error)}
          onChange={(event) => {
            setSample(event.currentTarget.value);
            setError(null);
            setResult(null);
          }}
        />
      </Field>
      <div className="inspector-inline">
        <button
          type="button"
          className="btn sm"
          data-testid="gate-tester-run"
          disabled={busy}
          onClick={() => void submit()}
        >
          <PlayCircle size={13} aria-hidden="true" />
          {busy ? "Testing…" : "Test branches"}
        </button>
        <span className="faint">
          Bounded: {MAX_EXPRESSION_BYTES}-byte conditions, {MAX_SCOPE_BYTES}-byte scope.
        </span>
      </div>
      <div aria-live="polite" data-testid="gate-tester-result">
        {result === null ? null : result.error !== undefined || chosen === null ? (
          <p className="inspector-error" role="alert" data-testid="gate-tester-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>
              {result.error?.message ??
                "The gate did not produce a boolean branch; the run would fail here."}
            </span>
          </p>
        ) : (
          <p className="inspector-note" data-testid="gate-tester-branch">
            <CheckCircle2 size={13} aria-hidden="true" />
            <span>
              Takes branch <b className="mono">{chosen}</b>.
            </span>
          </p>
        )}
        {result === null
          ? null
          : result.evaluated.map((entry) => (
              <div
                className="mono"
                key={entry.branch}
                data-testid={`gate-tester-evaluated-${entry.branch}`}
                style={{ fontSize: 11.5 }}
              >
                {entry.branch}: {entry.matched ? "true" : "false"}
                {entry.error === undefined ? "" : ` — ${entry.error}`}
              </div>
            ))}
      </div>
    </div>
  );
}

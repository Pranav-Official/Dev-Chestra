import type { DecisionTestResult } from "@relay/api";
import { MAX_DECISION_TEST_STATE_BYTES } from "@relay/api";
import type { DecisionNode } from "@relay/schema";
import { AlertCircle, CheckCircle2, PlayCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DecisionResultView } from "../../ui/DecisionResult.js";
import { workflowApi } from "../api/workflowApi.js";
import { describedBy, Field } from "./fields/fields.js";

export type DecisionTestRunner = (node: DecisionNode, state: string) => Promise<DecisionTestResult>;

export interface DecisionReadiness {
  ready: boolean;
  missing: string[];
  unknown: boolean;
}

function bytes(value: string): number {
  return typeof TextEncoder === "undefined" ? value.length : new TextEncoder().encode(value).length;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return "The decision test failed.";
}

/** Local preflight mirroring the schema limits; the server re-validates. */
export function decisionProblem(node: DecisionNode): string | null {
  if (node.instructions.trim() === "" || node.instructions.length > 4000) {
    return "Instructions must be 1–4000 characters before testing.";
  }
  const mode = node.mode;
  if (mode.kind === "choice") {
    if (mode.options.length === 0 || mode.options.length > 255) {
      return "A choice decision needs 1–255 options before testing.";
    }
    const seen = new Set<string>();
    for (const option of mode.options) {
      if (option.value === "" || seen.has(option.value)) {
        return "Choice option values must be unique and non-empty before testing.";
      }
      seen.add(option.value);
    }
    if (mode.branches.length === 0) return "A choice decision needs at least one branch.";
  }
  if (mode.kind === "score") {
    if (mode.levels.length < 2 || mode.levels.length > 10) {
      return "A score decision needs 2–10 levels before testing.";
    }
    const seen = new Set<string>();
    for (const level of mode.levels) {
      if (level.label === "" || seen.has(level.label)) {
        return "Score level labels must be unique and non-empty before testing.";
      }
      seen.add(level.label);
    }
    if (mode.bands.length === 0) return "A score decision needs at least one band.";
  }
  return null;
}

export function DecisionTester({
  node,
  projectId,
  readiness,
  runTest,
}: {
  node: DecisionNode;
  projectId?: string | undefined;
  readiness: DecisionReadiness;
  runTest?: DecisionTestRunner | undefined;
}) {
  const [sample, setSample] = useState("{}");
  const [result, setResult] = useState<DecisionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = `${projectId ?? ""}|${node.id}|${node.provider}|${node.model ?? ""}|${node.instructions}|${JSON.stringify(node.mode)}|${sample}`;
  const keyRef = useRef(key);
  const requestRef = useRef(0);

  useEffect(() => {
    keyRef.current = key;
    requestRef.current += 1;
    setResult(null);
    setBusy(false);
  }, [key]);

  const problem = decisionProblem(node);
  const blocked = !readiness.ready || problem !== null;

  const submit = async (): Promise<void> => {
    if (problem !== null) {
      setError(problem);
      return;
    }
    if (!readiness.ready) {
      setError(
        readiness.missing.length === 0
          ? "The provider is not ready. Check its configuration before testing."
          : `The provider is not ready. Missing: ${readiness.missing.join(", ")}.`,
      );
      return;
    }
    if (bytes(sample) > MAX_DECISION_TEST_STATE_BYTES) {
      setError(`Sample state exceeds ${MAX_DECISION_TEST_STATE_BYTES} bytes.`);
      return;
    }
    if (runTest === undefined && projectId === undefined) {
      setError("Open a saved project workflow to test a decision.");
      return;
    }
    const generation = requestRef.current + 1;
    requestRef.current = generation;
    const activeKey = key;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const runner: DecisionTestRunner =
        runTest ?? ((target, state) => workflowApi.testDecision(projectId ?? "", target, state));
      const next = await runner(node, sample);
      if (keyRef.current !== activeKey || requestRef.current !== generation) return;
      setResult(next);
    } catch (testError) {
      if (keyRef.current !== activeKey || requestRef.current !== generation) return;
      setError(messageOf(testError));
    } finally {
      if (keyRef.current === activeKey && requestRef.current === generation) setBusy(false);
    }
  };

  return (
    <div className="inspector-stack" data-testid="decision-tester">
      <Field
        id="decision-tester-state"
        label="Sample state"
        help="Sent as the decision state. This calls the real provider and may cost tokens."
        error={error}
      >
        <textarea
          id="decision-tester-state"
          className="inspector-input inspector-textarea inspector-code-input"
          data-testid="decision-tester-state"
          rows={5}
          spellCheck={false}
          value={sample}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy("decision-tester-state", undefined, error)}
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
          data-testid="decision-tester-run"
          disabled={busy || blocked}
          title={
            blocked
              ? (problem ?? "The provider is not ready.")
              : "Calls the real provider and may cost tokens."
          }
          onClick={() => void submit()}
        >
          <PlayCircle size={13} aria-hidden="true" />
          {busy ? "Asking…" : "Test decision"}
        </button>
        <span className="faint">Live provider call; it may cost tokens.</span>
      </div>
      <div aria-live="polite" data-testid="decision-tester-result">
        {error !== null ? (
          <p className="inspector-error" role="alert" data-testid="decision-tester-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{error}</span>
          </p>
        ) : null}
        {result === null ? null : (
          <>
            <p className="inspector-note" data-testid="decision-tester-branch">
              <CheckCircle2 size={13} aria-hidden="true" />
              <span>
                Takes branch <b className="mono">{result.routing.branch ?? "—"}</b> (
                {result.routing.reason}).
              </span>
            </p>
            <DecisionResultView
              output={result.output}
              routing={result.routing}
              latencyMs={result.latencyMs}
              usage={result.usage}
              testIdPrefix="decision-tester"
            />
          </>
        )}
      </div>
    </div>
  );
}

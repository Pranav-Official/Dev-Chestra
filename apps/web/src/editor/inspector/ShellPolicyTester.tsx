import {
  evaluateShellPolicy,
  type ShellPolicy,
  type ShellPolicyDecision,
} from "@devchestra/schema";
import { AlertCircle, CheckCircle2, PlayCircle } from "lucide-react";
import { useState } from "react";
import { describedBy, Field } from "./fields/fields.js";
import { shellPolicyProblems } from "./shellPolicyModel.js";

interface TesterResult {
  key: string;
  decision: ShellPolicyDecision;
}

/**
 * Local preview of the saved rules against one sample command, using the same
 * evaluator the runtime will use. Nothing is spawned, sent or logged.
 */
export function ShellPolicyTester({ policy }: { policy: ShellPolicy }) {
  const [command, setCommand] = useState("");
  const [result, setResult] = useState<TesterResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const problems = shellPolicyProblems(policy);
  const blocked = problems.length > 0;
  // A result belongs to the rules and command it was computed from; any edit hides it.
  const currentKey = `${JSON.stringify(policy)}\u0000${command}`;
  const shown = result !== null && result.key === currentKey ? result.decision : null;

  const run = (): void => {
    if (blocked) {
      setError("Fix the invalid rules above before checking a command.");
      return;
    }
    if (command.trim() === "") {
      setError("Enter a command to check.");
      return;
    }
    setError(null);
    setResult({ key: currentKey, decision: evaluateShellPolicy(policy, command) });
  };

  const helpId = "shell-policy-tester-command-help";
  return (
    <div className="inspector-stack" data-testid="shell-policy-tester">
      <Field
        id="shell-policy-tester-command"
        label="Sample command"
        help="Preview only: the rules are checked and the command is not run. Quotes group words; nothing else is expanded."
        error={error}
      >
        <input
          id="shell-policy-tester-command"
          className="inspector-input mono"
          data-testid="shell-policy-tester-command"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="curl -sS https://example.com"
          value={command}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy("shell-policy-tester-command", helpId, error)}
          onChange={(event) => {
            setCommand(event.currentTarget.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            run();
          }}
        />
      </Field>
      <div className="inspector-inline">
        <button
          type="button"
          className="btn sm"
          data-testid="shell-policy-tester-run"
          disabled={blocked}
          title={blocked ? "Fix the invalid rules above first." : undefined}
          onClick={run}
        >
          <PlayCircle size={13} aria-hidden="true" />
          Check command
        </button>
        <span className="faint" data-testid="shell-policy-tester-preview">
          Preview only; command not executed.
        </span>
      </div>
      <div aria-live="polite" data-testid="shell-policy-tester-result">
        {shown === null ? null : shown.allow ? (
          <>
            <p className="inspector-note" data-testid="shell-policy-tester-allow">
              <CheckCircle2 size={13} aria-hidden="true" />
              <span>Allowed.</span>
            </p>
            <div
              className="mono"
              data-testid="shell-policy-tester-argv"
              style={{ fontSize: 11.5, overflowWrap: "anywhere" }}
            >
              Canonical argv: {JSON.stringify(shown.argv)}
            </div>
          </>
        ) : (
          <p className="inspector-error" role="alert" data-testid="shell-policy-tester-deny">
            <AlertCircle size={12} aria-hidden="true" />
            {shown.rule === undefined ? (
              <span>Denied. {shown.reason}</span>
            ) : (
              <span>
                Denied by deny rule <span className="mono">{shown.rule}</span>. Deny rules run
                first.
              </span>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

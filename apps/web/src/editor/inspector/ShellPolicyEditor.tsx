import type { AgentNode, ShellPolicy } from "@devchestra/schema";
import { validateShellPolicy } from "@devchestra/schema";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { useBufferFlag } from "./BufferContext.js";
import { CheckboxField, describedBy, Field } from "./fields/fields.js";
import { ShellPolicyTester } from "./ShellPolicyTester.js";
import {
  permissionsWithoutShellPolicy,
  SHELL_POLICY_PRESETS,
  type ShellPolicyKind,
  shellPatternProblem,
} from "./shellPolicyModel.js";
import type { PatchOf } from "./types.js";

const SANDBOX_NOTE =
  "Not an OS sandbox. Patterns see only the command text. Interpreters such as python, sh or node, plus env, xargs and find -exec, can run programs the patterns never see, and extra MCP servers with exec tools bypass this policy. Regexes are a guardrail, not a complete security boundary.";

function PatternRow({
  kind,
  index,
  pattern,
  onCommit,
  onRemove,
}: {
  kind: ShellPolicyKind;
  index: number;
  pattern: string;
  onCommit: (index: number, next: string) => void;
  onRemove: (index: number) => void;
}) {
  const id = `inspector-shell-policy-${kind}-${index}`;
  const localError = shellPatternProblem(kind, index, pattern);
  useBufferFlag(id, localError);
  return (
    <div className="inspector-inline" data-testid={`${id}-row`}>
      <input
        id={id}
        className="inspector-input mono"
        data-testid={id}
        type="text"
        spellCheck={false}
        autoComplete="off"
        placeholder="^rg [^;|&<>$`]+$"
        value={pattern}
        aria-label={`${kind} pattern ${index + 1}`}
        aria-invalid={localError ? true : undefined}
        aria-describedby={describedBy(id, undefined, localError)}
        onChange={(event) => onCommit(index, event.currentTarget.value)}
      />
      <button
        type="button"
        className="btn sm ghost danger"
        data-testid={`inspector-shell-policy-${kind}-remove-${index}`}
        aria-label={`Remove ${kind} pattern ${index + 1}`}
        onClick={() => onRemove(index)}
      >
        Remove
      </button>
      {localError ? (
        <p
          className="inspector-error"
          id={`${id}-error`}
          role="alert"
          style={{ flexBasis: "100%" }}
        >
          <AlertCircle size={12} aria-hidden="true" />
          <span>{localError}</span>
        </p>
      ) : null}
    </div>
  );
}

function PatternList({
  kind,
  patterns,
  onAdd,
  onCommit,
  onRemove,
}: {
  kind: ShellPolicyKind;
  patterns: string[];
  onAdd: () => void;
  onCommit: (index: number, next: string) => void;
  onRemove: (index: number) => void;
}) {
  const id = `inspector-shell-policy-${kind}`;
  return (
    <Field
      id={id}
      label={kind === "allow" ? "Allow patterns" : "Deny patterns"}
      help={
        kind === "allow"
          ? "Non-empty allow is an allowlist: a command that matches no allow pattern is denied. Matched against the canonical command."
          : "Deny runs first and wins over allow. Matched against the canonical command."
      }
    >
      <div className="inspector-stack" data-testid={`${id}-list`}>
        {patterns.length === 0 ? (
          <p className="inspector-muted" data-testid={`${id}-empty`}>
            {kind === "allow"
              ? "Empty: every command that is not denied is allowed."
              : "No deny rules."}
          </p>
        ) : null}
        {patterns.map((pattern, index) => (
          <PatternRow
            // biome-ignore lint/suspicious/noArrayIndexKey: rules have no identity beyond their position; the index keeps each row's in-progress text with its slot.
            key={`${kind}-${index}`}
            kind={kind}
            index={index}
            pattern={pattern}
            onCommit={onCommit}
            onRemove={onRemove}
          />
        ))}
        <div>
          <button type="button" className="btn sm" data-testid={`${id}-add`} onClick={onAdd}>
            Add {kind} pattern
          </button>
        </div>
      </div>
    </Field>
  );
}

/**
 * Restrict commands on an agent: a deny-first regex policy over the canonical
 * command. Writes `permissions.shellPolicy`; enabling it makes `shell` explicit.
 */
export function ShellPolicyEditor({
  node,
  onPatch,
}: {
  node: AgentNode;
  onPatch: (patch: PatchOf<AgentNode>) => void;
}) {
  const policy = node.permissions.shellPolicy;
  const restricted = policy !== undefined;
  const extraServers = node.mcpServers ?? [];
  const allow = policy?.allow ?? [];
  const deny = policy?.deny ?? [];
  const listProblems = policy
    ? validateShellPolicy(policy).filter((problem) => !/^\/(allow|deny)\//.test(problem.path))
    : [];

  const setPolicy = (next: ShellPolicy | undefined, enable = false): void => {
    const permissions =
      next === undefined
        ? { ...permissionsWithoutShellPolicy(node.permissions), shell: true }
        : {
            ...node.permissions,
            ...(enable ? { shell: true } : {}),
            shellPolicy: next,
          };
    onPatch({ permissions });
  };

  const replaceRules = (kind: ShellPolicyKind, next: string[]): void => {
    setPolicy({ ...(policy ?? {}), [kind]: next });
  };

  return (
    <div className="inspector-stack" data-testid="inspector-shell-policy">
      <CheckboxField
        id="inspector-shell-policy-toggle"
        label="Restrict commands"
        hint="Allow or deny patterns over each command"
        checked={restricted}
        help="Turning this on also turns shell commands on. Deny runs first; a non-empty allow list is an allowlist. Patterns use RE2 regular expressions and match the whole canonical command. Arguments containing spaces, quotes, or backslashes are JSON-quoted, so boundaries remain visible. End a rule with .* to cover its arguments. Compounds, redirects, pipes, globbing and $ expansion are rejected. POSIX shells only in v1."
        onChange={(enabled) => {
          if (enabled) setPolicy({ allow: [], deny: [] }, true);
          else setPolicy(undefined);
        }}
      />
      {policy === undefined ? null : (
        <>
          {extraServers.length > 0 ? (
            <p
              className="inspector-note amber"
              role="status"
              data-testid="inspector-shell-policy-mcp-warning"
            >
              <AlertTriangle size={13} aria-hidden="true" />
              <span>
                Extra MCP servers are selected ({extraServers.map((entry) => entry.name).join(", ")}
                ). A server with an exec tool can run commands outside this policy.
              </span>
            </p>
          ) : null}
          {listProblems.map((problem) => (
            <p className="inspector-error" role="alert" key={problem.path}>
              <AlertCircle size={12} aria-hidden="true" />
              <span>{problem.message}</span>
            </p>
          ))}
          <fieldset className="inspector-fieldset" data-testid="inspector-shell-policy-presets">
            <legend className="inspector-label">Presets</legend>
            <div className="inspector-inline">
              {SHELL_POLICY_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="btn sm"
                  data-testid={`inspector-shell-policy-preset-${preset.id}`}
                  title={`${preset.description} Replaces the allow and deny rules; limits are kept.`}
                  onClick={() => {
                    setPolicy({
                      ...(policy.timeoutSec !== undefined ? { timeoutSec: policy.timeoutSec } : {}),
                      ...(policy.maxOutputBytes !== undefined
                        ? { maxOutputBytes: policy.maxOutputBytes }
                        : {}),
                      allow: [...preset.allow],
                      deny: [...preset.deny],
                    });
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </fieldset>
          <PatternList
            kind="allow"
            patterns={allow}
            onAdd={() => replaceRules("allow", [...allow, ""])}
            onCommit={(index, next) =>
              replaceRules(
                "allow",
                allow.map((entry, position) => (position === index ? next : entry)),
              )
            }
            onRemove={(index) =>
              replaceRules(
                "allow",
                allow.filter((_, position) => position !== index),
              )
            }
          />
          <PatternList
            kind="deny"
            patterns={deny}
            onAdd={() => replaceRules("deny", [...deny, ""])}
            onCommit={(index, next) =>
              replaceRules(
                "deny",
                deny.map((entry, position) => (position === index ? next : entry)),
              )
            }
            onRemove={(index) =>
              replaceRules(
                "deny",
                deny.filter((_, position) => position !== index),
              )
            }
          />
          <p className="inspector-help" role="note" data-testid="inspector-shell-policy-sandbox">
            {SANDBOX_NOTE}
          </p>
          <p className="inspector-note amber" role="status">
            Shell policy execution is currently unavailable until the gateway can enforce filesystem
            and network permissions.
          </p>
          <ShellPolicyTester policy={policy} />
        </>
      )}
    </div>
  );
}

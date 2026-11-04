import { type AgentPermissions, type ShellPolicy, validateShellPolicy } from "@devchestra/schema";

export type ShellPolicyKind = "allow" | "deny";

/** Permissions with `shellPolicy` removed (the key is absent, not undefined). */
export function permissionsWithoutShellPolicy(permissions: AgentPermissions): AgentPermissions {
  const { shellPolicy: _removed, ...rest } = permissions;
  return rest;
}

export interface ShellPolicyPreset {
  id: string;
  label: string;
  description: string;
  allow: string[];
  deny: string[];
}

/*
 * Patterns match the WHOLE canonical command (the runtime wraps each one as
 * ^(?:...)$), so a deny rule that should catch a flag anywhere must end in
 * `.*`. Each preset must pass `validateShellPolicy`, and the inspector tests
 * check that its deny rules fire on real commands.
 */
const SHELLS = "^(sh|bash|python3?|node|env|xargs|find)\\b.*$";

/** Starting rule sets for common read-only work. Guardrails, not a sandbox. */
export const SHELL_POLICY_PRESETS: readonly ShellPolicyPreset[] = [
  {
    id: "web-research",
    label: "Web research",
    description: "curl, ripgrep and jq. Blocks curl file output, rg --pre and shells.",
    allow: ["^curl -s[SL]* https?://[^ ]+$", "^rg [^;|&<>$`]+$", "^jq [^;|&<>$`]+$"],
    deny: [
      "^curl\\b.*\\s(-o|-O|--output|--remote-name)(\\s.*|=.*|$)",
      "^rg\\b.*\\s(--pre|--hostname-bin)(\\s.*|=.*|$)",
      SHELLS,
    ],
  },
  {
    id: "read-only-git",
    label: "Read-only git",
    description: "git status, log, show and diff. Blocks --output and mutating git commands.",
    allow: ["^git (status|log|show|diff)$", "^git (status|log|show|diff) [^;|&<>$`]*$"],
    deny: [
      "^git\\b.*\\s--output(\\s.*|=.*|$)",
      "^git (push|commit|checkout|reset|clean|rm|config)\\b.*$",
      SHELLS,
    ],
  },
  {
    id: "repo-search",
    label: "Repo search",
    description: "rg, git grep and ls. Blocks pagers, rg --pre and shells.",
    allow: ["^rg [^;|&<>$`]+$", "^git grep [A-Za-z0-9_./: ]+$", "^ls$", "^ls [^;|&<>$`]*$"],
    deny: [
      "^rg\\b.*\\s(--pre|--hostname-bin)(\\s.*|=.*|$)",
      "^git grep\\b.*\\s(-O.*|--open-files-in-pager.*)$",
      SHELLS,
    ],
  },
];

/**
 * Inline message for one allow/deny pattern, or null when it is usable. Uses
 * the exported schema check so the editor and the workflow validator agree.
 */
export function shellPatternProblem(
  kind: ShellPolicyKind,
  index: number,
  pattern: string,
): string | null {
  if (pattern.trim() === "") {
    return `Pattern ${index + 1} is empty. Enter a regex or remove the row.`;
  }
  const [problem] = validateShellPolicy({ [kind]: [pattern] });
  if (problem === undefined) return null;
  return problem.message.replace(
    new RegExp(`^shellPolicy\\.${kind}\\[0\\] `),
    `Pattern ${index + 1} `,
  );
}

/**
 * Messages that make a policy unsafe to preview: schema problems, including blank patterns.
 */
export function shellPolicyProblems(policy: ShellPolicy): string[] {
  return validateShellPolicy(policy).map((problem) => problem.message);
}

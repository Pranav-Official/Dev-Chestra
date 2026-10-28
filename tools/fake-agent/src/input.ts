export const AGENT_INPUT_CONTEXT_START = "<devchestra_input_context>";
export const AGENT_INPUT_CONTEXT_END = "</devchestra_input_context>";
export const MAX_INPUT_PATH_SEGMENTS = 32;

export interface AgentInputPathResult {
  present: boolean;
  value: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function promptLines(prompt: string): string[] {
  return prompt.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Extract the engine's automatic workflow input scope from the prompt this
 * process actually received. Only the fixed marker lines are recognised; the
 * canonical JSON must be one physical line. Missing, duplicated or malformed
 * blocks fail instead of returning a guessed value.
 */
export function parseAgentInputScope(prompt: string): Record<string, unknown> {
  const lines = promptLines(prompt);
  const starts = lines.flatMap((line, index) =>
    line === AGENT_INPUT_CONTEXT_START ? [index] : [],
  );
  const ends = lines.flatMap((line, index) => (line === AGENT_INPUT_CONTEXT_END ? [index] : []));

  if (starts.length === 0) {
    throw new Error(`Agent prompt is missing the ${AGENT_INPUT_CONTEXT_START} JSON block.`);
  }
  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error(
      `Agent prompt must contain exactly one ${AGENT_INPUT_CONTEXT_START}...${AGENT_INPUT_CONTEXT_END} block.`,
    );
  }
  const start = starts[0];
  const end = ends[0];
  if (start === undefined || end === undefined || end !== start + 2) {
    throw new Error(
      "Agent prompt input context must contain exactly one JSON line between its markers.",
    );
  }

  const json = lines[start + 1] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown parse error";
    throw new Error(`Agent prompt input context is not valid JSON: ${message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("Agent prompt input context must be a JSON object.");
  }
  return parsed;
}

/**
 * Walk a JSON path using own properties only. Present null/false/0/empty-string
 * values are distinct from an absent path, and inherited names such as
 * `constructor` or `toString` are never selected.
 */
export function selectAgentInputPath(
  scope: unknown,
  path: readonly string[],
): AgentInputPathResult {
  let current: unknown = scope;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
      return { present: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { present: true, value: current };
}

/**
 * Compute the submit_result arguments for a `submit-from-inputs` step.
 * A valid marker block is mandatory; absence of the requested path is the only
 * case that returns the scripted fallback. A present value always wins, even if
 * it is null, false, 0 or an empty string.
 */
export function resolveSubmitFromInputs(
  prompt: string,
  path: readonly string[],
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  const scope = parseAgentInputScope(prompt);
  const selected = selectAgentInputPath(scope, path);
  return selected.present ? { received: selected.value } : fallback;
}

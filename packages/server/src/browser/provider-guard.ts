import {
  buildRequires,
  isProdCliId,
  type NormalizedWorkflow,
  PROD_CLI_LABELS,
} from "@devchestra/schema";

/** Agent providers the workflow needs (including loop and foreach bodies) that are turned off. */
export function disabledClisRequired(
  snapshot: NormalizedWorkflow,
  disabled: ReadonlySet<string>,
): string[] {
  return buildRequires(snapshot.graph.nodes).clis.filter((cli) => disabled.has(cli));
}

/**
 * Friendly 409 returned before any run row exists. Built by hand because the
 * server's local error-code union does not list E_CLI_DISABLED yet.
 */
export function providersOffResponse(clis: readonly string[]) {
  const labels = clis.map((cli) => (isProdCliId(cli) ? PROD_CLI_LABELS[cli] : cli));
  const verb = clis.length === 1 ? "is" : "are";
  return {
    error: {
      code: "E_CLI_DISABLED",
      message: `${labels.join(", ")} ${verb} turned off. Turn it on in Settings > Providers.`,
      details: { clis: [...clis] },
    },
  };
}

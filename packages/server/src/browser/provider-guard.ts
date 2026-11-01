import {
  buildRequires,
  isProdCliId,
  type NormalizedWorkflow,
  PROD_CLI_LABELS,
} from "@devchestra/schema";
import { errorBody } from "../errors.js";

/** Agent providers the workflow needs (including loop and foreach bodies) that are turned off. */
export function disabledClisRequired(
  snapshot: NormalizedWorkflow,
  disabled: ReadonlySet<string>,
): string[] {
  return buildRequires(snapshot.graph.nodes).clis.filter((cli) => disabled.has(cli));
}

/** Friendly 409 returned before any run row exists. */
export function providersOffResponse(clis: readonly string[]) {
  const labels = clis.map((cli) => (isProdCliId(cli) ? PROD_CLI_LABELS[cli] : cli));
  const verb = clis.length === 1 ? "is" : "are";
  return errorBody(
    "E_CLI_DISABLED",
    `${labels.join(", ")} ${verb} turned off. Turn it on in Settings > Providers.`,
    { clis: [...clis] },
  );
}

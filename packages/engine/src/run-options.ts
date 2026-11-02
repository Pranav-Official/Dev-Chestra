import { DevChestraError, err, isRecord, ok, type Result } from "@devchestra/core";

export interface RunOptionInput {
  readonly snapshot: unknown;
  readonly budgets?: unknown;
  readonly baseSha?: unknown;
  readonly kind?: unknown;
}

function invalid(message: string, details?: unknown): DevChestraError {
  return new DevChestraError(
    "E_WORKFLOW_INVALID",
    message,
    details === undefined ? {} : { details },
  );
}

export function validateRunOptions(input: RunOptionInput): Result<null, DevChestraError> {
  try {
    if (input.kind !== undefined && input.kind !== "run") {
      throw invalid("Only kind 'run' is supported", { kind: input.kind });
    }
    if (input.baseSha !== undefined && input.baseSha !== null) {
      if (typeof input.baseSha !== "string" || input.baseSha === "") {
        throw invalid("baseSha must be a non-empty string when supplied");
      }
      throw invalid(
        "Worktree base selection is not supported; worktrees start from the project HEAD at first acquisition",
      );
    }
    if (input.budgets === undefined || input.budgets === null) return ok(null);
    if (!isRecord(input.budgets)) throw invalid("budgets must be an object");
    for (const key of Object.keys(input.budgets)) {
      throw invalid(`Budget '${key}' is not enforced; remove it`);
    }
    return ok(null);
  } catch (error) {
    if (error instanceof DevChestraError) return err(error);
    throw error;
  }
}

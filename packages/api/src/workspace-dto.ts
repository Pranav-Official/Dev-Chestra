import type { RunWorkspaceSelection } from "@devchestra/core";
import { z } from "./zod.js";

/**
 * One workspace for one workflow execution. Chosen at Start; every agent and
 * shell node in the run shares this working directory. `project` uses the
 * registered project root, `existing-worktree` must be a worktree of that Git
 * project (validated server-side), and `new-worktree` is created by the engine
 * under its data directory. Browser callers never send a project root.
 */
export type { RunWorkspaceSelection } from "@devchestra/core";

const worktreePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), "Worktree path must not contain NUL");

export const runWorkspaceSelectionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("project") }),
  z.strictObject({ mode: z.literal("existing-worktree"), path: worktreePathSchema }),
  z.strictObject({ mode: z.literal("new-worktree") }),
  z.strictObject({ mode: z.literal("container"), includeUncommitted: z.boolean().optional() }),
]) as unknown as z.ZodType<RunWorkspaceSelection>;

export interface ProjectWorkspaceEntry {
  path: string;
  branch: string | null;
  head: string;
  detached: boolean;
}

export const projectWorkspaceEntrySchema = z.strictObject({
  path: z.string().min(1),
  branch: z.string().nullable(),
  head: z.string().min(1),
  detached: z.boolean(),
}) as unknown as z.ZodType<ProjectWorkspaceEntry>;

/** Git worktree catalog for a project. The project root is the default, not an alternative. */
export interface ProjectWorkspacesResponse {
  projectRoot: string;
  worktrees: readonly ProjectWorkspaceEntry[];
  git: boolean;
}

export const projectWorkspacesResponseSchema = z.strictObject({
  projectRoot: z.string().min(1),
  worktrees: z.array(projectWorkspaceEntrySchema),
  git: z.boolean(),
}) as unknown as z.ZodType<ProjectWorkspacesResponse>;

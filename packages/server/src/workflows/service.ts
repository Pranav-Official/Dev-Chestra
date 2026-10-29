import {
  hashWorkflow,
  MAX_WORKFLOW_FILE_BYTES,
  type NormalizedWorkflow,
  normalizeWorkflow,
  parseWorkflowDraft,
  serializeWorkflow,
  type ValidationReport,
  validateParams,
  validateWorkflow,
  type WorkflowFile,
  workflowNodes,
} from "@devchestra/schema";
import { assertProjectPathAllowed } from "../browser/workflow.js";
import { DevChestraError } from "../errors.js";
import {
  assertWorkflowId,
  createManagedFile,
  deleteManagedFile,
  listManagedIds,
  type ManagedFile,
  type ManagedPaths,
  managedPaths,
  readManagedFile,
  replaceManagedFile,
} from "./io.js";
import { withProjectLock } from "./lock.js";
import { ensureProjectSkill } from "./skill.js";

export interface WorkflowProject {
  id: string;
  path: string;
  kind: "git" | "folder";
  missing: boolean;
}

export interface WorkflowValidationSummary {
  ok: boolean;
  errors: number;
  warnings: number;
}

export interface WorkflowListItemView {
  id: string;
  name: string;
  description: string | null;
  relativeFile: string;
  etag: string;
  updatedAt: number;
  validationSummary: WorkflowValidationSummary;
}

export interface WorkflowDocumentView {
  workflow: WorkflowFile;
  text: string;
  etag: string;
  relativeFile: string;
  validation: ValidationReport;
}

export interface CreateWorkflowInput {
  name: string;
  id?: string;
  template?: "blank" | "linear" | "linear-fake";
}

export interface SaveWorkflowInput {
  workflow: WorkflowFile;
}

export interface RunWorkflowInput {
  params?: Record<string, unknown>;
  etag: string;
}

export interface RunWorkflowSnapshot {
  workflowId: string;
  workflowFile: string;
  snapshot: NormalizedWorkflow;
  snapshotRaw: string;
  workflowHash: string;
  params: Record<string, unknown>;
}

export interface ManagedWorkflowServiceDeps {
  dataDir: string;
  providers?: string[];
  now?: () => number;
}

export class ManagedWorkflowService {
  readonly #dataDir: string;
  readonly #providers: string[] | undefined;

  constructor(deps: ManagedWorkflowServiceDeps) {
    this.#dataDir = deps.dataDir;
    this.#providers = deps.providers;
  }

  #root(project: WorkflowProject): string {
    if (project.missing) {
      throw new DevChestraError(
        "E_CONFLICT",
        "Project path is missing; relink the project before editing workflows.",
      );
    }
    try {
      return assertProjectPathAllowed(project.path, this.#dataDir);
    } catch (error) {
      if (error instanceof DevChestraError && error.code === "E_NOT_FOUND") {
        throw new DevChestraError(
          "E_CONFLICT",
          "Project path is missing; relink the project before editing workflows.",
        );
      }
      throw error;
    }
  }

  #paths(project: WorkflowProject, create: boolean): ManagedPaths {
    const root = this.#root(project);
    const paths = managedPaths(root, { create });
    if (paths === null) {
      throw new DevChestraError("E_NOT_FOUND", "The project has no managed workflows yet.");
    }
    // Backfill for projects registered before the guide existed; no-op when present.
    if (create) ensureProjectSkill(root);
    return paths;
  }

  #context(project: WorkflowProject): { providers?: string[]; projectKind: "git" | "folder" } {
    return {
      projectKind: project.kind,
      ...(this.#providers === undefined ? {} : { providers: this.#providers }),
    };
  }

  #validate(file: WorkflowFile, project: WorkflowProject): ValidationReport {
    return validateWorkflow(file, this.#context(project));
  }

  #document(project: WorkflowProject, file: ManagedFile): WorkflowDocumentView {
    const parsed = parseWorkflowJsonOrThrow(file.text);
    if (parsed.id !== file.id) {
      throw new DevChestraError("E_VALIDATION", "Workflow id must equal the file stem.", {
        field: "id",
        expected: file.id,
      });
    }
    const validation = this.#validate(parsed, project);
    return {
      workflow: parsed,
      text: file.text,
      etag: file.etag,
      relativeFile: file.relativeFile,
      validation,
    };
  }

  listPage(
    project: WorkflowProject,
    options: { cursor?: string; limit: number },
  ): { items: WorkflowListItemView[]; nextCursor: string | null } {
    const paths = managedPaths(this.#root(project), { create: false });
    if (paths === null) return { items: [], nextCursor: null };
    const ids = listManagedIds(paths);
    let start = 0;
    if (options.cursor !== undefined) {
      const index = ids.indexOf(options.cursor);
      if (index === -1) {
        throw new DevChestraError("E_VALIDATION", "Workflow cursor is not valid for this list.");
      }
      start = index + 1;
    }
    const pageIds = ids.slice(start, start + options.limit);
    const items: WorkflowListItemView[] = [];
    for (const id of pageIds) {
      let file: ManagedFile;
      try {
        file = readManagedFile(paths, id);
      } catch {
        continue;
      }
      try {
        const workflow = parseWorkflowJsonOrThrow(file.text);
        if (workflow.id !== file.id) {
          throw new DevChestraError("E_VALIDATION", "Workflow id must equal the file stem.");
        }
        const validation = this.#validate(workflow, project);
        items.push({
          id: file.id,
          name: workflow.name,
          description: workflow.description ?? null,
          relativeFile: file.relativeFile,
          etag: file.etag,
          updatedAt: file.updatedAt,
          validationSummary: {
            ok: validation.ok,
            errors: validation.errors.length,
            warnings: validation.warnings.length,
          },
        });
      } catch {
        items.push({
          id: file.id,
          name: file.id,
          description: null,
          relativeFile: file.relativeFile,
          etag: file.etag,
          updatedAt: file.updatedAt,
          validationSummary: { ok: false, errors: 1, warnings: 0 },
        });
      }
    }
    const hasMore = ids.length > start + pageIds.length;
    const last = pageIds.at(-1);
    return {
      items,
      nextCursor: hasMore && last !== undefined ? last : null,
    };
  }

  get(project: WorkflowProject, id: string): WorkflowDocumentView {
    assertWorkflowId(id);
    const paths = this.#paths(project, false);
    return this.#document(project, readManagedFile(paths, id));
  }

  async create(
    project: WorkflowProject,
    input: CreateWorkflowInput,
  ): Promise<WorkflowDocumentView> {
    const paths = this.#paths(project, true);
    const explicitId = input.id === undefined ? null : assertWorkflowId(input.id);
    const template = input.template ?? "blank";
    return withProjectLock(paths.root, async () => {
      const baseId = explicitId ?? idFromName(input.name);
      const attempts = explicitId === null ? 100 : 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const id = attempt === 0 ? baseId : `${baseId.slice(0, 60)}-${attempt + 1}`;
        const file =
          template === "blank" ? blankTemplate(id, input.name) : linearTemplate(id, input.name);
        const text = serializeOrThrow(file);
        assertSize(text);
        try {
          const created = createManagedFile(paths, id, Buffer.from(text, "utf8"));
          return this.#document(project, created);
        } catch (error) {
          if (
            explicitId === null &&
            error instanceof DevChestraError &&
            error.code === "E_CONFLICT"
          ) {
            continue;
          }
          throw error;
        }
      }
      throw new DevChestraError("E_CONFLICT", "Could not allocate a workflow id.");
    });
  }

  async save(
    project: WorkflowProject,
    id: string,
    workflow: WorkflowFile,
    expectedEtag: string,
  ): Promise<WorkflowDocumentView> {
    assertWorkflowId(id);
    if (workflow.id !== id) {
      throw new DevChestraError("E_VALIDATION", "Workflow id must equal the file stem.", {
        field: "id",
        expected: id,
      });
    }
    const parsed = parseWorkflowOrThrow(workflow);
    const text = serializeOrThrow(parsed);
    assertSize(text);
    const paths = this.#paths(project, true);
    return withProjectLock(paths.root, async () => {
      const saved = replaceManagedFile(paths, id, Buffer.from(text, "utf8"), expectedEtag);
      return this.#document(project, saved);
    });
  }

  async remove(project: WorkflowProject, id: string, expectedEtag: string): Promise<void> {
    assertWorkflowId(id);
    const paths = this.#paths(project, false);
    await withProjectLock(paths.root, async () => {
      deleteManagedFile(paths, id, expectedEtag);
    });
  }

  validate(project: WorkflowProject, id: string, workflow: WorkflowFile): ValidationReport {
    assertWorkflowId(id);
    const parsed = parseWorkflowOrThrow(workflow);
    const validation = this.#validate(parsed, project);
    if (parsed.id !== id) {
      return {
        ...validation,
        ok: false,
        errors: [
          {
            severity: "error",
            code: "E_WORKFLOW_ID",
            message: `Workflow id '${parsed.id}' must equal the route id '${id}'.`,
            pointer: "/id",
          },
          ...validation.errors,
        ],
      };
    }
    return validation;
  }

  async run(
    project: WorkflowProject,
    id: string,
    input: RunWorkflowInput,
  ): Promise<RunWorkflowSnapshot> {
    assertWorkflowId(id);
    const paths = this.#paths(project, false);
    const file = readManagedFile(paths, id);
    if (file.etag !== input.etag) {
      throw new DevChestraError(
        "E_CONFLICT",
        "The workflow changed on disk. Review and save it before running.",
        { currentEtag: file.etag },
      );
    }
    const workflow = parseWorkflowJsonOrThrow(file.text);
    if (workflow.id !== id) {
      throw new DevChestraError("E_VALIDATION", "Workflow id must equal the file stem.", {
        field: "id",
        expected: id,
      });
    }
    const prompts = [...workflowNodes(workflow.graph)].filter(
      (node) => node.type === "agent" && node.promptFile !== undefined,
    );
    if (prompts.length > 0) {
      throw new DevChestraError(
        "E_NOT_SUPPORTED",
        "promptFile is not supported for managed workflow runs yet; inline the prompt and save.",
        { nodeIds: prompts.map((node) => node.id) },
      );
    }
    const validation = this.#validate(workflow, project);
    if (!validation.ok) {
      throw new DevChestraError(
        "E_VALIDATION",
        `Workflow is invalid: ${validation.errors[0]?.message ?? "unknown error"}`,
        { issues: validation.errors, warnings: validation.warnings },
      );
    }
    const params = validateParams(
      workflow,
      (input.params ?? {}) as Record<string, string | number | boolean>,
    );
    if (!params.ok) {
      throw new DevChestraError("E_VALIDATION", "Run parameters are invalid", {
        issues: params.errors,
      });
    }
    const normalized = normalizeWorkflow(workflow);
    if (!normalized.ok) {
      throw new DevChestraError("E_VALIDATION", normalized.error.message, normalized.error.details);
    }
    const workflowHash = await hashWorkflow(normalized.value);
    return {
      workflowId: id,
      workflowFile: file.relativeFile,
      snapshot: normalized.value,
      snapshotRaw: file.text,
      workflowHash,
      params: input.params ?? {},
    };
  }
}

function parseWorkflowOrThrow(value: unknown): WorkflowFile {
  const parsed = parseWorkflowDraft(value);
  if (!parsed.ok)
    throw new DevChestraError("E_VALIDATION", parsed.error.message, parsed.error.details);
  return parsed.value;
}

function parseWorkflowJsonOrThrow(text: string): WorkflowFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DevChestraError("E_VALIDATION", "Workflow file is not valid JSON.");
  }
  return parseWorkflowOrThrow(raw);
}

function serializeOrThrow(file: WorkflowFile): string {
  const serialized = serializeWorkflow(file);
  if (!serialized.ok) {
    const details = serialized.error.details;
    if (typeof details === "object" && details !== null && "maxBytes" in details) {
      throw new DevChestraError("E_PAYLOAD_TOO_LARGE", serialized.error.message, details);
    }
    throw new DevChestraError("E_VALIDATION", serialized.error.message, details);
  }
  return serialized.value;
}

function assertSize(text: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_WORKFLOW_FILE_BYTES) {
    throw new DevChestraError("E_PAYLOAD_TOO_LARGE", "Workflow file exceeds the 1 MiB limit.", {
      bytes,
      maxBytes: MAX_WORKFLOW_FILE_BYTES,
    });
  }
}

function idFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/u, "");
  return slug === "" ? "workflow" : slug;
}

function blankTemplate(id: string, name: string): WorkflowFile {
  return {
    schemaVersion: 1,
    id,
    name,
    graph: { nodes: [], edges: [] },
  };
}

function linearTemplate(id: string, name: string): WorkflowFile {
  return {
    schemaVersion: 1,
    id,
    name,
    graph: {
      nodes: [
        {
          id: "start",
          type: "start",
          name: "Start",
          params: [],
          ui: { x: 80, y: 160 },
        },
        {
          id: "agent",
          type: "agent",
          name: "Agent",
          ui: { x: 320, y: 160 },
          cli: "codex",
          prompt: "Say hello to the run.",
          output: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
            required: ["message"],
            additionalProperties: false,
          },
          permissions: { network: false, write: [] },
        },
        {
          id: "end",
          type: "end",
          name: "End",
          ui: { x: 560, y: 160 },
          status: "success",
          result: '{"message": agent.message}',
        },
      ],
      edges: [
        { id: "e1", from: "start", to: "agent" },
        { id: "e2", from: "agent", to: "end" },
      ],
    },
  };
}

import assert from "node:assert/strict";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CLI, FIXTURE_ROOT, makeWorkspace, readFixture, scriptPath } from "./fixtures.js";
import { DevChestraHttp, errorCode, fieldString } from "./http.js";
import { type OwnedServer, shutdownOwned, startSentinel, startServer } from "./owned.js";
import {
  apiHeader,
  createWorkflow,
  defaultIdempotencyKey,
  deleteWorkflow,
  expectError,
  getRun,
  getWorkflow,
  isTerminal,
  listWorkflows,
  quoteEtag,
  readManagedFile,
  registerProject,
  saveWorkflow,
  startManagedRun,
  validateWorkflow,
  type WorkflowDocument,
  waitTerminal,
} from "./workflow-api.js";

export interface HttpEvidence {
  blankId: string;
  linearId: string;
  createdStatus: number;
  nodeTypes: string[];
  canonicalByteStable: boolean;
  layoutOnlyDiff: boolean;
  draftSemanticInvalidSaved: boolean;
  validationIssues: number;
  invalidRunRejected: number;
  run202: boolean;
  duplicateRunId: boolean;
  duplicateConflict: number;
  staleRunEtag: number;
  staleDetailsEtag: boolean;
  snapshotImmutable: boolean;
  finalStatus: string;
  deletedWorkflow: number;
  deleteKeptRun: boolean;
  deleteMissingIfMatch: number;
  unknownFieldRejected: number;
  etagHeaderQuoted: boolean;
}

function withoutUi(workflow: WorkflowDocument["workflow"]): unknown {
  const clone = structuredClone(workflow) as Record<string, unknown>;
  const graph = clone.graph as { nodes: Array<Record<string, unknown>> };
  for (const node of graph.nodes) delete node.ui;
  return clone;
}

function setAgentPrompt(
  workflow: WorkflowDocument["workflow"],
  prompt: string,
): WorkflowDocument["workflow"] {
  const clone = structuredClone(workflow);
  const node = clone.graph.nodes.find((item) => item.type === "agent");
  if (node === undefined) throw new Error("linear template has no agent node");
  node.prompt = prompt;
  return clone;
}

function moveNode(workflow: WorkflowDocument["workflow"]): WorkflowDocument["workflow"] {
  const clone = structuredClone(workflow);
  const node = clone.graph.nodes.find((item) => item.type === "agent");
  if (node === undefined) throw new Error("linear template has no agent node");
  const ui = (node.ui ?? {}) as Record<string, unknown>;
  node.ui = { ...ui, x: Number(ui.x ?? 0) + 48, y: Number(ui.y ?? 0) + 24 };
  return clone;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function runHttpScenario(): Promise<HttpEvidence> {
  const ws = await makeWorkspace("devchestra-p3-http-");
  const other = await makeWorkspace("devchestra-p3-http-other-");
  const sentinel = startSentinel();
  let server: OwnedServer | null = null;
  try {
    server = await startServer({
      cli: CLI,
      dataDir: ws.dataDir,
      cwd: ws.projectDir,
      fakeScript: scriptPath("slow"),
    });
    const http = new DevChestraHttp(server.baseUrl);
    await http.health();
    await http.bootstrap(server.meta.token);
    const project = await registerProject(http, ws.projectDir);
    const foreign = await registerProject(http, other.projectDir);
    assert.notEqual(project.id, foreign.id);

    const empty = await listWorkflows(http, project.id);
    assert.equal(empty.items.length, 0, "new project must have no managed workflows");

    const blankResult = await http.api(
      "POST",
      `/api/projects/${encodeURIComponent(project.id)}/workflows`,
      {
        body: { name: "QA Blank", id: "qa-blank", template: "blank" },
      },
    );
    assert.equal(blankResult.status, 201, `blank create: ${blankResult.text.slice(0, 500)}`);
    apiHeader(blankResult);
    const blank = await getWorkflow(http, project.id, "qa-blank");
    assert.equal(blank.workflow.id, "qa-blank");
    assert.equal(blank.relativeFile, ".devchestra/workflows/qa-blank.json");
    assert.equal(blank.workflow.graph.nodes.length, 0, "blank template starts with an empty graph");
    assert.equal(blank.validation.ok, false, "blank draft is saved with semantic errors");

    await createWorkflow(http, project.id, {
      name: "QA Linear",
      id: "qa-linear",
      template: "blank",
    });
    const linearBase = await getWorkflow(http, project.id, "qa-linear");
    const linearFixture = await readFixture<WorkflowDocument["workflow"]>(
      join(FIXTURE_ROOT, "workflows/p3-linear.json"),
    );
    const created = await saveWorkflow(
      http,
      project.id,
      "qa-linear",
      { ...linearFixture, id: "qa-linear" },
      linearBase.etag,
    );
    const linear = await getWorkflow(http, project.id, "qa-linear");
    const nodeTypes = linear.workflow.graph.nodes.map((node) => String(node.type));
    assert.deepEqual([...nodeTypes].sort(), ["agent", "end", "shell", "start"]);
    assert.ok(
      linear.validation.ok,
      `linear template must validate: ${JSON.stringify(linear.validation)}`,
    );
    const managed = await readManagedFile(ws.projectDir, linear.relativeFile);
    assert.equal(managed.text, linear.text, "GET text must equal the managed file bytes");
    assert.equal(linear.text, created.text, "save response text must equal reloaded text");

    const list = await listWorkflows(http, project.id);
    assert.equal(list.items.length, 2);
    assert.ok(list.items.every((item) => /^[A-Fa-f0-9]{64}$/u.test(item.etag)));

    const firstSave = await saveWorkflow(http, project.id, linear.id, linear.workflow, linear.etag);
    assert.equal(firstSave.text, linear.text, "canonical save must be byte-stable");
    const reload = await getWorkflow(http, project.id, linear.id);
    assert.equal(reload.text, linear.text, "reload after canonical save must be byte-stable");
    const secondSave = await saveWorkflow(
      http,
      project.id,
      linear.id,
      reload.workflow,
      reload.etag,
    );
    assert.equal(secondSave.text, reload.text, "save -> load -> save must be byte-stable");

    const moved = moveNode(reload.workflow);
    const afterMove = await saveWorkflow(http, project.id, linear.id, moved, reload.etag);
    assert.notEqual(afterMove.text, reload.text, "moving a node must change the file");
    assert.deepEqual(
      withoutUi(afterMove.workflow),
      withoutUi(reload.workflow),
      "layout move must change only ui",
    );
    const layoutReload = await getWorkflow(http, project.id, linear.id);
    const beforeUi = reload.workflow.graph.nodes.find((item) => item.type === "agent")?.ui;
    const afterUi = layoutReload.workflow.graph.nodes.find((item) => item.type === "agent")?.ui;
    assert.notDeepEqual(afterUi, beforeUi, "layout position must persist");

    const incompleteFixture = await readFixture<WorkflowDocument["workflow"]>(
      join(FIXTURE_ROOT, "workflows/p3-incomplete.json"),
    );
    await createWorkflow(http, project.id, {
      name: "QA Incomplete",
      id: "p3-incomplete",
      template: "blank",
    });
    const incompleteBase = await getWorkflow(http, project.id, "p3-incomplete");
    const incompleteDoc = await saveWorkflow(
      http,
      project.id,
      "p3-incomplete",
      { ...incompleteFixture, id: "p3-incomplete" },
      incompleteBase.etag,
    );
    assert.equal(
      incompleteDoc.validation.ok,
      false,
      "incomplete graph must be saved with invalid semantics",
    );
    assert.ok(
      incompleteDoc.validation.errors.length > 0,
      "incomplete save must report validation errors",
    );
    const incompleteReload = await getWorkflow(http, project.id, "p3-incomplete");
    assert.equal(incompleteReload.text, incompleteDoc.text, "draft invalid graph must persist");

    const invalidValidate = await validateWorkflow(
      http,
      project.id,
      "p3-incomplete",
      incompleteReload.workflow,
    );
    assert.equal(invalidValidate.report.ok, false);
    assert.ok(
      invalidValidate.report.errors.some((issue) =>
        String(issue.message ?? "")
          .toLowerCase()
          .includes("end"),
      ),
      "cycle/unreachable errors must be actionable",
    );
    const invalidRun = await http.api(
      "POST",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/p3-incomplete/runs`,
      {
        body: { params: { topic: "invalid" }, etag: incompleteReload.etag },
        idempotencyKey: defaultIdempotencyKey(),
      },
    );
    expectError(invalidRun, [400, 422], "invalid workflow run");
    assert.ok(
      [400, 422].includes(invalidRun.status),
      "semantic invalid graph must not start a run",
    );
    assert.equal(errorCode(invalidRun), "E_VALIDATION");

    const repairedWorkflow = structuredClone(incompleteReload.workflow);
    repairedWorkflow.graph.edges.push({ id: "e-render-done", from: "render", to: "done" });
    const repaired = await saveWorkflow(
      http,
      project.id,
      "p3-incomplete",
      repairedWorkflow,
      incompleteReload.etag,
    );
    assert.ok(
      repaired.validation.ok,
      `repaired graph must validate: ${JSON.stringify(repaired.validation)}`,
    );

    const bufferBefore = await listWorkflows(http, project.id);
    assert.equal(bufferBefore.items.length, 3, "saving/validating must not create workflows");
    const runsBefore = await http.api("GET", `/api/runs?project=${encodeURIComponent(project.id)}`);
    const runsBeforeBody = runsBefore.body as { items?: unknown[] };
    assert.equal(runsBeforeBody.items?.length ?? 0, 0, "save/validate must not execute a run");

    const runKey = defaultIdempotencyKey();
    const run = await startManagedRun(http, project.id, "p3-incomplete", {
      params: { topic: "P3 acceptance" },
      etag: repaired.etag,
      idempotencyKey: runKey,
    });
    const immediate = await getRun(http, run.runId);
    const run202 = !isTerminal(immediate.status);
    const duplicate = await startManagedRun(http, project.id, "p3-incomplete", {
      params: { topic: "P3 acceptance" },
      etag: repaired.etag,
      idempotencyKey: runKey,
    });
    assert.equal(duplicate.runId, run.runId, "same Idempotency-Key must return one run");
    assert.equal(duplicate.duplicate, true);
    const conflict = await http.api(
      "POST",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/p3-incomplete/runs`,
      {
        body: { params: { topic: "different" }, etag: repaired.etag },
        idempotencyKey: runKey,
      },
    );
    expectError(conflict, [409], "idempotency body conflict");
    assert.equal(errorCode(conflict), "E_CONFLICT");

    const latest = await getWorkflow(http, project.id, "p3-incomplete");
    const edited = setAgentPrompt(latest.workflow, "Edited after run started: {{ start.topic }}");
    const afterEdit = await saveWorkflow(http, project.id, "p3-incomplete", edited, latest.etag);
    assert.notEqual(afterEdit.etag, latest.etag, "semantic edit must advance the ETag");
    const staleRun = await http.api(
      "POST",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/p3-incomplete/runs`,
      {
        body: { params: { topic: "stale" }, etag: latest.etag },
        idempotencyKey: defaultIdempotencyKey(),
      },
    );
    expectError(staleRun, [409], "stale managed run ETag");
    assert.equal(errorCode(staleRun), "E_CONFLICT");
    const staleBody = staleRun.body as { error?: { details?: { currentEtag?: unknown } } };
    const staleDetailsEtag =
      staleBody.error?.details?.currentEtag === afterEdit.etag ||
      (typeof staleBody.error?.details?.currentEtag === "string" &&
        quoteEtag(afterEdit.etag) === staleBody.error.details.currentEtag);

    const terminal = await waitTerminal(http, run.runId, 90_000);
    assert.equal(
      terminal.status,
      "succeeded",
      `run failed: ${JSON.stringify(terminal.raw).slice(0, 1200)}`,
    );
    const snapshot = terminal.raw.snapshot as WorkflowDocument["workflow"] | undefined;
    const snapshotAgent = snapshot?.graph.nodes.find((item) => item.type === "agent");
    assert.ok(
      typeof snapshotAgent?.prompt === "string" && snapshotAgent.prompt.includes("Summarize"),
      "run snapshot must preserve the revision that started it",
    );
    assert.ok(
      !String(snapshotAgent?.prompt).includes("Edited after run started"),
      "later workflow edit must not mutate a past run snapshot",
    );

    const runList = await http.api("GET", `/api/runs?project=${encodeURIComponent(project.id)}`);
    const runListBody = runList.body as { items?: Array<{ id?: string }> };
    assert.equal(runListBody.items?.length ?? 0, 1, "double-click/retry must create one run");

    const runAgentId = repaired.workflow.graph.nodes.find((node) => node.type === "agent")?.id;
    assert.equal(typeof runAgentId, "string", "repaired workflow must declare an agent id");
    const execution = await http.api(
      "GET",
      `/api/runs/${encodeURIComponent(run.runId)}/executions/${encodeURIComponent(String(runAgentId))}`,
    );
    assert.equal(execution.status, 200, "completed agent execution must be readable");
    const workspaceDir = fieldString(execution.body, ["workspace", "dir"]);
    assert.ok(workspaceDir !== null && workspaceDir !== "", "agent scratch workspace path missing");
    assert.equal(
      await fileExists(workspaceDir),
      true,
      "completed run workspace must exist before delete",
    );

    const latestBeforeDelete = await getWorkflow(http, project.id, "p3-incomplete");
    const deleted = await deleteWorkflow(
      http,
      project.id,
      "p3-incomplete",
      latestBeforeDelete.etag,
    );
    assert.equal(deleted.status, 204, `DELETE: ${deleted.status} ${deleted.text}`);
    const afterDelete = await http.api(
      "GET",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/p3-incomplete`,
    );
    expectError(afterDelete, [404], "deleted workflow read");
    assert.equal(await fileExists(join(ws.projectDir, latestBeforeDelete.relativeFile)), false);
    assert.equal(await fileExists(workspaceDir), true, "delete must not remove run workspaces");
    const runAfterDelete = await http.api("GET", `/api/runs/${encodeURIComponent(run.runId)}`);
    assert.equal(runAfterDelete.status, 200, "deleting a definition must keep its run");
    const stillRun = await http.api("GET", `/api/runs?project=${encodeURIComponent(project.id)}`);
    assert.equal((stillRun.body as { items?: unknown[] }).items?.length ?? 0, 1);

    const missingIfMatch = await http.api(
      "DELETE",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/qa-linear`,
      { headers: { "Content-Type": "application/json" } },
    );
    expectError(missingIfMatch, [400, 409, 428], "DELETE without If-Match");

    const unknownField = await http.api(
      "PUT",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/qa-linear`,
      { body: { workflow: linear.workflow, extra: "nope" }, ifMatch: quoteEtag(linear.etag) },
    );
    expectError(unknownField, [400], "unknown PUT field");

    const finalList = await listWorkflows(http, project.id);
    assert.ok(finalList.items.every((item) => item.id !== "p3-incomplete"));
    const tempEntries = await readdir(join(ws.projectDir, ".devchestra/workflows"));
    assert.ok(
      tempEntries.every((name) => name.endsWith(".json") && !name.startsWith(".")),
      `unexpected temporary/lock file in managed directory: ${tempEntries.join(",")}`,
    );

    return {
      blankId: blank.id,
      linearId: linear.id,
      createdStatus: blankResult.status,
      nodeTypes,
      canonicalByteStable: true,
      layoutOnlyDiff: true,
      draftSemanticInvalidSaved: true,
      validationIssues: invalidValidate.report.errors.length,
      invalidRunRejected: invalidRun.status,
      run202,
      duplicateRunId: true,
      duplicateConflict: conflict.status,
      staleRunEtag: staleRun.status,
      staleDetailsEtag,
      snapshotImmutable: true,
      finalStatus: terminal.status,
      deletedWorkflow: deleted.status,
      deleteKeptRun: runAfterDelete.status === 200,
      deleteMissingIfMatch: missingIfMatch.status,
      unknownFieldRejected: unknownField.status,
      etagHeaderQuoted: true,
    };
  } finally {
    if (server !== null) {
      await shutdownOwned({
        server,
        agents: [],
        sentinel,
        keep: false,
        dataDir: ws.root,
      });
    } else {
      sentinel.kill("SIGKILL");
    }
  }
}

export async function restartPersistenceScenario(): Promise<{
  sameText: boolean;
  projectId: string;
  workflowId: string;
}> {
  const ws = await makeWorkspace("devchestra-p3-restart-");
  const sentinel = startSentinel();
  let first: OwnedServer | null = null;
  let second: OwnedServer | null = null;
  try {
    first = await startServer({
      cli: CLI,
      dataDir: ws.dataDir,
      cwd: ws.projectDir,
      fakeScript: scriptPath("summary"),
    });
    const http = new DevChestraHttp(first.baseUrl);
    await http.health();
    await http.bootstrap(first.meta.token);
    const project = await registerProject(http, ws.projectDir);
    const created = await createWorkflow(http, project.id, {
      name: "Restart survives",
      id: "restart-survives",
      template: "blank",
    });
    const beforeText = created.text;
    await first.stop();
    first = null;

    second = await startServer({
      cli: CLI,
      dataDir: ws.dataDir,
      cwd: ws.projectDir,
      fakeScript: scriptPath("summary"),
    });
    const http2 = new DevChestraHttp(second.baseUrl);
    await http2.health();
    await http2.bootstrap(second.meta.token);
    const reloaded = await getWorkflow(http2, project.id, "restart-survives");
    const sameText = reloaded.text === beforeText;
    assert.ok(sameText, "workflow file must survive restart byte-for-byte");
    await second.stop();
    second = null;
    sentinel.kill("SIGKILL");
    return { sameText, projectId: project.id, workflowId: created.id };
  } finally {
    if (first !== null) await first.stop().catch(() => undefined);
    if (second !== null) await second.stop().catch(() => undefined);
    if (sentinel.exitCode === null && sentinel.signalCode === null) sentinel.kill("SIGKILL");
  }
}

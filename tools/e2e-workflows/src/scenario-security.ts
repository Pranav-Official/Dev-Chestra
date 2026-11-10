import assert from "node:assert/strict";
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { CLI, makeWorkspace, scriptPath } from "./fixtures.js";
import { DevChestraHttp, errorCode, type HttpResult } from "./http.js";
import { type OwnedServer, shutdownOwned, startSentinel, startServer } from "./owned.js";
import {
  apiHeader,
  createWorkflow,
  defaultIdempotencyKey,
  deleteWorkflow,
  expectError,
  getWorkflow,
  listWorkflows,
  quoteEtag,
  readManagedFile,
  registerProject,
  saveWorkflow,
  validateWorkflow,
} from "./workflow-api.js";

export interface SecurityEvidence {
  cases: Array<{ name: string; status: number }>;
  noRunSideEffects: boolean;
  externalEditConflict: number;
  wildcardRejected: number;
  deleteManagedOnly: boolean;
  atomicDirectoryClean: boolean;
  headersStrict: boolean;
}

function record(cases: SecurityEvidence["cases"], name: string, result: HttpResult): void {
  cases.push({ name, status: result.status });
}

async function runCount(http: DevChestraHttp, projectId: string): Promise<number> {
  const result = await http.api("GET", `/api/runs?project=${encodeURIComponent(projectId)}`);
  assert.equal(result.status, 200);
  return ((result.body as { items?: unknown[] }).items ?? []).length;
}

export async function runSecurityScenario(): Promise<SecurityEvidence> {
  const ws = await makeWorkspace("devchestra-security-");
  const other = await makeWorkspace("devchestra-security-other-");
  const sentinel = startSentinel();
  let server: OwnedServer | null = null;
  const cases: SecurityEvidence["cases"] = [];
  try {
    server = await startServer({
      secure: true,
      cli: CLI,
      dataDir: ws.dataDir,
      cwd: ws.projectDir,
      fakeScript: scriptPath("summary"),
    });
    const http = new DevChestraHttp(server.baseUrl);
    await http.health();
    await http.bootstrap(server.meta.token);
    const project = await registerProject(http, ws.projectDir);
    const foreign = await registerProject(http, other.projectDir);
    const workflow = await createWorkflow(http, project.id, {
      name: "Security managed",
      id: "security-managed",
      template: "blank",
    });

    const missingCookie = await http.api("GET", "/api/bootstrap", { cookie: null });
    assert.equal(missingCookie.status, 401);
    record(cases, "missing-cookie", missingCookie);

    const wrongHost = await http.api("GET", "/api/health", {
      cookie: null,
      host: `evil.example:${String(server.meta.port)}`,
    });
    assert.equal(wrongHost.status, 421);
    record(cases, "wrong-host", wrongHost);

    const foreignOrigin = await http.api("POST", "/api/projects", {
      body: { path: other.projectDir },
      origin: "http://evil.example",
    });
    expectError(foreignOrigin, [403], "foreign origin");
    record(cases, "foreign-origin", foreignOrigin);

    const missingCsrf = await http.api(
      "POST",
      `/api/projects/${encodeURIComponent(project.id)}/workflows`,
      { body: { name: "no csrf", template: "blank" }, csrf: false },
    );
    expectError(missingCsrf, [403], "missing CSRF");
    record(cases, "missing-csrf", missingCsrf);

    const missingContentType = await http.api(
      "POST",
      `/api/projects/${encodeURIComponent(project.id)}/workflows`,
      { body: { name: "no type", template: "blank" }, omitContentType: true },
    );
    expectError(missingContentType, [403], "missing content type");
    record(cases, "missing-content-type", missingContentType);

    const cookieOnInternal = await http.api("POST", "/internal/agent/tools", { body: {} });
    assert.ok(cookieOnInternal.status >= 400);
    record(cases, "cookie-on-internal", cookieOnInternal);

    const unknownApi = await http.api("GET", "/api/definitely-not-a-route");
    assert.equal(unknownApi.status, 404);
    record(cases, "unknown-api", unknownApi);

    const insideData = await http.api("POST", "/api/projects", { body: { path: ws.dataDir } });
    expectError(insideData, [403], "project inside data dir");
    record(cases, "project-inside-data", insideData);

    const ancestorData = await http.api("POST", "/api/projects", { body: { path: ws.root } });
    expectError(ancestorData, [403], "project ancestor of data dir");
    record(cases, "project-ancestor-data", ancestorData);

    const unknownCreateField = await http.api(
      "POST",
      `/api/projects/${encodeURIComponent(project.id)}/workflows`,
      { body: { name: "bad", template: "blank", script: [] } },
    );
    expectError(unknownCreateField, [400], "unknown create field");
    record(cases, "unknown-create-field", unknownCreateField);

    const badTemplate = await http.api(
      "POST",
      `/api/projects/${encodeURIComponent(project.id)}/workflows`,
      { body: { name: "bad", template: "map" } },
    );
    expectError(badTemplate, [400], "unsupported template");
    record(cases, "unsupported-template", badTemplate);

    const badId = await http.api(
      "POST",
      `/api/projects/${encodeURIComponent(project.id)}/workflows`,
      { body: { name: "bad", id: "UPPER_CASE", template: "blank" } },
    );
    expectError(badId, [400], "invalid workflow id");
    record(cases, "invalid-workflow-id", badId);

    for (const [name, wid] of [
      ["dotdot", "../../etc/passwd"],
      ["encoded-dotdot", "..%2F..%2Fetc%2Fpasswd"],
      ["encoded-slash", "%2e%2e%2fsecurity-managed"],
      ["absolute", "%2Fetc%2Fpasswd"],
      ["nul", "security-managed%00"],
      ["dotdot-json", "..%2Fescape.json"],
    ] as const) {
      const result = await http.api(
        "GET",
        `/api/projects/${encodeURIComponent(project.id)}/workflows/${wid}`,
      );
      assert.ok([400, 403, 404].includes(result.status), `${name} traversal got ${result.status}`);
      record(cases, `wid-${name}`, result);
    }

    const foreignWrite = await http.api(
      "PUT",
      `/api/projects/${encodeURIComponent(foreign.id)}/workflows/security-managed`,
      { body: { workflow: workflow.workflow }, ifMatch: quoteEtag(workflow.etag) },
    );
    expectError(foreignWrite, [404], "foreign project write");
    record(cases, "foreign-project-write", foreignWrite);
    const unchanged = await readManagedFile(ws.projectDir, workflow.relativeFile);
    assert.equal(
      unchanged.text,
      workflow.text,
      "foreign project write must not touch the owner file",
    );

    const missingIfMatch = await http.api(
      "PUT",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/security-managed`,
      { body: { workflow: workflow.workflow } },
    );
    assert.ok([400, 409, 428].includes(missingIfMatch.status));
    record(cases, "missing-if-match", missingIfMatch);

    const wildcardPut = await http.api(
      "PUT",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/security-managed`,
      { body: { workflow: workflow.workflow }, ifMatch: "*" },
    );
    assert.ok([400, 409, 428].includes(wildcardPut.status), "wildcard If-Match must not overwrite");
    record(cases, "wildcard-if-match", wildcardPut);

    const unknownPutField = await http.api(
      "PUT",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/security-managed`,
      {
        body: { workflow: workflow.workflow, etag: workflow.etag },
        ifMatch: quoteEtag(workflow.etag),
      },
    );
    expectError(unknownPutField, [400], "unknown PUT field");
    record(cases, "unknown-put-field", unknownPutField);

    const unknownValidateField = await http.api(
      "POST",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/security-managed/validate`,
      { body: { workflow: workflow.workflow, path: "../outside" } },
    );
    expectError(unknownValidateField, [400], "unknown validate field");
    record(cases, "unknown-validate-field", unknownValidateField);

    const missingEtagRun = await http.api(
      "POST",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/security-managed/runs`,
      { body: { params: {} }, idempotencyKey: defaultIdempotencyKey() },
    );
    expectError(missingEtagRun, [400], "run without etag");
    record(cases, "run-missing-etag", missingEtagRun);

    const oversizeJson = await http.api(
      "POST",
      `/api/projects/${encodeURIComponent(project.id)}/workflows`,
      {
        rawBody: `{"name":"big","template":"blank","padding":"${"a".repeat(2_200_000)}"}`,
        contentType: "application/json",
      },
    );
    assert.equal(oversizeJson.status, 413);
    record(cases, "oversize-json", oversizeJson);

    const hugeWorkflow = structuredClone(workflow.workflow);
    const hugeAgent = hugeWorkflow.graph.nodes.find((item) => item.type === "agent");
    if (hugeAgent === undefined) {
      hugeWorkflow.graph.nodes.push({
        id: "agent-big",
        type: "agent",
        name: "Big agent",
        cli: "fake",
        prompt: "x".repeat(1_200_000),
        output: { type: "object", additionalProperties: false, required: [], properties: {} },
        permissions: { network: false, write: [] },
        workspace: { mode: "scratch" },
      });
    } else {
      hugeAgent.prompt = "x".repeat(1_200_000);
    }
    const oversizeWorkflow = await http.api(
      "PUT",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/security-managed`,
      {
        body: { workflow: hugeWorkflow },
        ifMatch: quoteEtag(workflow.etag),
      },
    );
    assert.ok(
      [400, 413].includes(oversizeWorkflow.status),
      `oversize workflow should reject, got ${oversizeWorkflow.status}`,
    );
    record(cases, "oversize-workflow", oversizeWorkflow);

    const outsideFile = join(ws.root, "outside-workflow.json");
    const outsideText = JSON.stringify({ marker: "do-not-touch" });
    await writeFile(outsideFile, outsideText, "utf8");
    const workflowsDir = join(ws.projectDir, ".devchestra/workflows");
    await symlink(outsideFile, join(workflowsDir, "escape.json"));
    const symlinkGet = await http.api(
      "GET",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/escape`,
    );
    assert.ok([400, 403, 404].includes(symlinkGet.status), "symlink target must not be readable");
    record(cases, "symlink-final-get", symlinkGet);
    const symlinkPut = await http.api(
      "PUT",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/escape`,
      { body: { workflow: workflow.workflow }, ifMatch: quoteEtag(workflow.etag) },
    );
    assert.ok([400, 403, 409].includes(symlinkPut.status), "symlink target must not be writable");
    record(cases, "symlink-final-put", symlinkPut);
    assert.equal(await readFile(outsideFile, "utf8"), outsideText, "symlink write escaped");

    await unlink(join(workflowsDir, "escape.json"));
    const hardTarget = join(ws.root, "hard-workflow.json");
    await writeFile(hardTarget, outsideText, "utf8");
    await link(hardTarget, join(workflowsDir, "hard.json"));
    const hardGet = await http.api(
      "GET",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/hard`,
    );
    assert.ok(
      [400, 403, 409].includes(hardGet.status),
      "hard-linked managed file must be rejected",
    );
    record(cases, "hardlink-get", hardGet);
    const hardPut = await http.api(
      "PUT",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/hard`,
      { body: { workflow: workflow.workflow }, ifMatch: quoteEtag(workflow.etag) },
    );
    assert.ok(
      [400, 403, 409].includes(hardPut.status),
      "hard-linked managed file must not be written",
    );
    record(cases, "hardlink-put", hardPut);
    assert.equal(await readFile(hardTarget, "utf8"), outsideText, "hardlink write escaped");

    const symProject = join(ws.root, "sym-project");
    const symOutside = join(ws.root, "sym-outside");
    await mkdir(symProject, { recursive: true });
    await mkdir(join(symProject, ".devchestra"), { recursive: true });
    await mkdir(symOutside, { recursive: true });
    await symlink(symOutside, join(symProject, ".devchestra/workflows"));
    const symProjectView = await registerProject(http, symProject);
    const symCreate = await http.api(
      "POST",
      `/api/projects/${encodeURIComponent(symProjectView.id)}/workflows`,
      { body: { name: "escape parent", id: "escape-parent", template: "blank" } },
    );
    assert.ok(
      [400, 403, 409].includes(symCreate.status),
      `symlink managed parent must be rejected, got ${symCreate.status}`,
    );
    record(cases, "symlink-parent-create", symCreate);
    assert.equal(
      (await readdir(symOutside)).length,
      0,
      "symlink parent create escaped the project",
    );

    const beforeExternal = await getWorkflow(http, project.id, "security-managed");
    const externalWorkflow = structuredClone(beforeExternal.workflow);
    const externalAgent = externalWorkflow.graph.nodes.find((item) => item.type === "agent");
    if (externalAgent !== undefined) externalAgent.name = "Externally edited";
    externalWorkflow.name = "External edit";
    const externalText = `${JSON.stringify(externalWorkflow, null, 2)}\n`;
    await writeFile(join(ws.projectDir, beforeExternal.relativeFile), externalText, "utf8");
    const current = await getWorkflow(http, project.id, "security-managed");
    assert.equal(current.text, externalText, "GET must observe an external disk edit");
    const stalePut = await http.api(
      "PUT",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/security-managed`,
      { body: { workflow: beforeExternal.workflow }, ifMatch: quoteEtag(beforeExternal.etag) },
    );
    expectError(stalePut, [409], "external edit stale If-Match");
    assert.equal(errorCode(stalePut), "E_CONFLICT");
    record(cases, "external-edit-stale-put", stalePut);
    assert.equal(
      await readFile(join(ws.projectDir, beforeExternal.relativeFile), "utf8"),
      externalText,
    );

    const currentDoc = await getWorkflow(http, project.id, "security-managed");
    const validate = await validateWorkflow(
      http,
      project.id,
      "security-managed",
      currentDoc.workflow,
    );
    assert.equal(validate.status, 200);
    const save = await saveWorkflow(
      http,
      project.id,
      "security-managed",
      currentDoc.workflow,
      currentDoc.etag,
    );
    const canonicalReload = await getWorkflow(http, project.id, "security-managed");
    assert.equal(save.text, canonicalReload.text, "canonical save must match the next reload");
    assert.notEqual(
      save.text,
      externalText,
      "an externally written non-canonical file must be canonicalized",
    );
    const noSideEffects = (await runCount(http, project.id)) === 0;

    const headersResult = await http.api(
      "GET",
      `/api/projects/${encodeURIComponent(project.id)}/workflows`,
    );
    apiHeader(headersResult);
    const csp = (headersResult.headers["content-security-policy"] ?? "").toString();
    const nosniff = (headersResult.headers["x-content-type-options"] ?? "").toString();
    const referrer = (headersResult.headers["referrer-policy"] ?? "").toString();
    const cache = (headersResult.headers["cache-control"] ?? "").toString();
    const headersStrict =
      csp.includes("default-src 'self'") &&
      csp.includes("connect-src 'self'") &&
      !csp.includes("unsafe-eval") &&
      nosniff === "nosniff" &&
      referrer === "no-referrer" &&
      cache.includes("no-store");
    assert.ok(
      headersStrict,
      `security headers are not strict: ${JSON.stringify(headersResult.headers)}`,
    );

    const deleteMissing = await http.api(
      "DELETE",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/security-managed`,
      { headers: { "Content-Type": "application/json" } },
    );
    assert.ok([400, 409, 428].includes(deleteMissing.status));
    record(cases, "delete-missing-if-match", deleteMissing);
    const deleteWildcard = await http.api(
      "DELETE",
      `/api/projects/${encodeURIComponent(project.id)}/workflows/security-managed`,
      { ifMatch: "*", headers: { "Content-Type": "application/json" } },
    );
    assert.ok([400, 409, 428].includes(deleteWildcard.status));
    record(cases, "delete-wildcard-if-match", deleteWildcard);

    const currentForDelete = await getWorkflow(http, project.id, "security-managed");
    const deleted = await deleteWorkflow(
      http,
      project.id,
      "security-managed",
      currentForDelete.etag,
    );
    assert.equal(deleted.status, 204);
    assert.equal(
      await lstat(join(ws.projectDir, currentForDelete.relativeFile)).catch(() => null),
      null,
      "managed definition must be removed",
    );
    assert.ok(await lstat(ws.projectDir), "project directory must survive workflow delete");
    const deleteManagedOnly = true;
    const remaining = await listWorkflows(http, project.id);
    assert.equal(
      remaining.items.some((item) => item.id === "security-managed"),
      false,
    );

    await unlink(join(workflowsDir, "hard.json")).catch(() => undefined);
    const directory = await readdir(workflowsDir);
    const atomicDirectoryClean = directory.every(
      (name) => name.endsWith(".json") && !name.startsWith("."),
    );
    assert.ok(atomicDirectoryClean, `temporary files left behind: ${directory.join(",")}`);

    return {
      cases,
      noRunSideEffects: noSideEffects,
      externalEditConflict: stalePut.status,
      wildcardRejected: wildcardPut.status,
      deleteManagedOnly,
      atomicDirectoryClean,
      headersStrict,
    };
  } finally {
    if (server !== null) {
      await shutdownOwned({ server, agents: [], sentinel, keep: false, dataDir: ws.root });
    } else {
      sentinel.kill("SIGKILL");
    }
  }
}

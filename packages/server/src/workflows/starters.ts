import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowFile } from "@devchestra/schema";
import { PROD_CLIS } from "@devchestra/schema";
import { DevChestraError } from "../errors.js";
import type { ManagedWorkflowService, WorkflowProject } from "./service.js";

export type StarterCli = (typeof PROD_CLIS)[number];

export interface StarterOptions {
  testCommand: string;
}

export const DEFAULT_STARTER_CLI: StarterCli = "claude-code";
const FALLBACK_TEST_COMMAND = "npm test";

const TEST_COMMANDS: readonly { file: string; command: string }[] = [
  { file: "package.json", command: "npm test --silent" },
  { file: "Cargo.toml", command: "cargo test" },
  { file: "go.mod", command: "go test ./..." },
  { file: "pyproject.toml", command: "pytest" },
];

/** Best-guess test command from the project's manifest, or a placeholder to edit. */
export function detectTestCommand(projectRoot: string): string {
  const hit = TEST_COMMANDS.find((entry) => existsSync(join(projectRoot, entry.file)));
  return hit?.command ?? FALLBACK_TEST_COMMAND;
}

/** First installed, enabled CLI in registry order; falls back to the default. */
export function pickStarterCli(
  ready: ReadonlySet<string>,
  disabled: ReadonlySet<string> = new Set(),
): StarterCli {
  return PROD_CLIS.find((cli) => ready.has(cli) && !disabled.has(cli)) ?? DEFAULT_STARTER_CLI;
}

function projectTour(): WorkflowFile {
  return {
    schemaVersion: 1,
    id: "project-tour",
    name: "Tour this project",
    description:
      "Starter: a read-only agent surveys the project and a shell step lists recent commits. Safe to run anywhere.",
    graph: {
      nodes: [
        {
          id: "start",
          type: "start",
          name: "Start",
          ui: { x: 60, y: 160 },
          params: [
            {
              name: "focus",
              type: "enum",
              options: ["overview", "architecture", "risks"],
              default: "overview",
              required: true,
            },
          ],
        },
        {
          id: "survey",
          type: "agent",
          name: "Survey the project",
          ui: { x: 320, y: 160 },
          tier: "medium",
          prompt:
            "Survey this project with a {{ start.focus }} focus. Read the README, the manifest files and the top-level layout. Report only what you verified in the files; do not modify anything.",
          output: {
            type: "object",
            properties: {
              summary: {
                type: "string",
                description: "Two or three sentences on what this project is.",
              },
              stack: {
                type: "array",
                items: { type: "string" },
                maxItems: 12,
                description: "Languages, frameworks and key tools.",
              },
              entryPoints: {
                type: "array",
                items: { type: "string" },
                maxItems: 12,
                description: "Workspace-relative paths a newcomer should open first.",
              },
              risks: {
                type: "array",
                items: { type: "string" },
                maxItems: 8,
                description: "Things that look fragile, outdated or undocumented.",
              },
            },
            required: ["summary", "stack", "entryPoints", "risks"],
            additionalProperties: false,
          },
          permissions: { network: false, write: [] },
          limits: { timeoutMin: 15 },
        },
        {
          id: "history",
          type: "shell",
          name: "Recent commits",
          ui: { x: 580, y: 160 },
          command: "git log --oneline -n 5",
          timeoutMin: 2,
          allowFailure: true,
        },
        {
          id: "done",
          type: "end",
          name: "Done",
          ui: { x: 840, y: 160 },
          status: "success",
          result:
            '{"summary": survey.summary, "stack": survey.stack, "entryPoints": survey.entryPoints, "risks": survey.risks, "recentCommits": history.stdout}',
        },
      ],
      edges: [
        { id: "e-start-survey", from: "start", to: "survey" },
        { id: "e-survey-history", from: "survey", to: "history" },
        { id: "e-history-done", from: "history", to: "done" },
      ],
    },
  };
}

function fixUntilGreen({ testCommand }: StarterOptions): WorkflowFile {
  return {
    schemaVersion: 1,
    id: "fix-until-green",
    name: "Fix failing tests",
    description: `Starter: run the tests, let an agent fix failures for up to 3 rounds, then ask before keeping the changes. Edit the test command in the shell nodes if "${testCommand}" is not right for this project. Best run in a fresh worktree.`,
    graph: {
      nodes: [
        {
          id: "start",
          type: "start",
          name: "Start",
          ui: { x: 60, y: 200 },
          params: [],
        },
        {
          id: "test",
          type: "shell",
          name: "Run tests",
          ui: { x: 300, y: 200 },
          command: testCommand,
          timeoutMin: 15,
          allowFailure: true,
        },
        {
          id: "route",
          type: "gate",
          name: "Tests green?",
          ui: { x: 540, y: 200 },
          branches: [
            { id: "green", when: "test.exitCode = 0" },
            { id: "red", otherwise: true },
          ],
        },
        {
          id: "already_green",
          type: "end",
          name: "Already green",
          ui: { x: 800, y: 60 },
          status: "success",
          result: '{"outcome": "already green"}',
        },
        {
          id: "fixer",
          type: "loop",
          name: "Fix and retest",
          ui: { x: 800, y: 260 },
          mode: "repeatUntil",
          maxIterations: 3,
          initialState: '{"failure": test.stdout}',
          result: '{"testExit": retest.exitCode, "summary": fix.summary, "failure": retest.stdout}',
          until: "result.testExit = 0",
          nextState: '{"failure": result.failure}',
          output: {
            type: "object",
            properties: {
              testExit: { type: "integer" },
              summary: { type: "string" },
              failure: { type: "string" },
            },
            required: ["testExit", "summary", "failure"],
            additionalProperties: false,
          },
          body: {
            nodes: [
              {
                id: "start",
                type: "start",
                name: "Start round",
                ui: { x: 40, y: 120 },
                params: [],
              },
              {
                id: "fix",
                type: "agent",
                name: "Fix the failure",
                ui: { x: 300, y: 120 },
                tier: "high",
                prompt:
                  "The project's tests are failing. This is round {{ loop.iteration }} of {{ loop.maxIterations }}.\nLatest test output:\n{{ loop.state.failure }}\nFind the root cause and make the smallest change that fixes it, editing files in the workspace. Do not weaken or delete tests. A later step reruns the tests.",
                output: {
                  type: "object",
                  properties: {
                    summary: { type: "string", description: "What you changed and why." },
                  },
                  required: ["summary"],
                  additionalProperties: false,
                },
                permissions: { network: false, write: ["workspace"] },
                limits: { timeoutMin: 30 },
              },
              {
                id: "retest",
                type: "shell",
                name: "Rerun tests",
                ui: { x: 560, y: 120 },
                command: testCommand,
                timeoutMin: 15,
                allowFailure: true,
              },
              {
                id: "end",
                type: "end",
                name: "End round",
                ui: { x: 820, y: 120 },
                status: "success",
                result: "{}",
              },
            ],
            edges: [
              { id: "b-start-fix", from: "start", to: "fix" },
              { id: "b-fix-retest", from: "fix", to: "retest" },
              { id: "b-retest-end", from: "retest", to: "end" },
            ],
          },
        },
        {
          id: "review",
          type: "approval",
          name: "Keep these changes?",
          ui: { x: 1080, y: 200 },
          message:
            "Tests pass after {{ fixer.iterations }} round(s).\nLast change: {{ fixer.result.summary }}\nApprove to finish, or reject to discard.",
          criteria: [
            "The fix addresses the cause, not the symptom",
            "No tests were removed or weakened",
          ],
          irreversible: false,
        },
        {
          id: "fixed",
          type: "end",
          name: "Fixed",
          ui: { x: 1340, y: 140 },
          status: "success",
          result: '{"outcome": "fixed", "summary": fixer.result.summary}',
        },
        {
          id: "declined",
          type: "end",
          name: "Declined",
          ui: { x: 1340, y: 280 },
          status: "rejected",
          result: '{"outcome": "declined"}',
        },
        {
          id: "gave_up",
          type: "end",
          name: "Still failing",
          ui: { x: 1080, y: 380 },
          status: "failed",
          result: '{"outcome": "still failing", "lastOutput": fixer.result.failure}',
        },
      ],
      edges: [
        { id: "e-start-test", from: "start", to: "test" },
        { id: "e-test-route", from: "test", to: "route" },
        { id: "e-route-green", from: "route.green", to: "already_green" },
        { id: "e-route-red", from: "route.red", to: "fixer" },
        { id: "e-fixer-review", from: "fixer", to: "review" },
        { id: "e-fixer-exhausted", from: "fixer.exhausted", to: "gave_up" },
        { id: "e-review-fixed", from: "review", to: "fixed" },
        { id: "e-review-declined", from: "review.rejected", to: "declined" },
      ],
    },
  };
}

export function starterWorkflows(options: StarterOptions): WorkflowFile[] {
  return [projectTour(), fixUntilGreen(options)];
}

/**
 * Writes the starter workflows into a freshly registered project. They name model tiers, not a
 * provider, so they stay portable when committed. Existing ids are left alone; any other failure
 * is returned as the list of ids that could not be written so the caller can log it without
 * failing registration.
 */
export async function seedStarterWorkflows(
  service: ManagedWorkflowService,
  project: WorkflowProject,
  options: { testCommand?: string } = {},
): Promise<{ created: string[]; failed: string[] }> {
  const testCommand = options.testCommand ?? detectTestCommand(project.path);
  const created: string[] = [];
  const failed: string[] = [];
  for (const workflow of starterWorkflows({ testCommand })) {
    try {
      await service.create(project, { id: workflow.id, name: workflow.name, workflow });
      created.push(workflow.id);
    } catch (error) {
      if (error instanceof DevChestraError && error.code === "E_CONFLICT") continue;
      failed.push(workflow.id);
    }
  }
  return { created, failed };
}

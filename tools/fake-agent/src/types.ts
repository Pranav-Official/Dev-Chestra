export type FakeStep =
  | { type: "say"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown> }
  | { type: "submit"; output: Record<string, unknown> }
  | {
      type: "submit-from-inputs";
      path: string[];
      fallback: Record<string, unknown>;
    }
  | { type: "sleep"; ms: number }
  | { type: "crash"; code: number };

export interface FakeCheckpoint {
  version: 1;
  profile: "fake";
  sessionId: string;
  cwd: string;
  nextStepIndex: number;
  submitted: boolean;
}

export interface FakeRunContext {
  profile: "fake";
  sessionId: string;
  cwd: string;
  resumed: boolean;
}

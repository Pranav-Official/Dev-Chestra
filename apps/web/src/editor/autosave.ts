import type { ValidationReport, WorkflowFile } from "@devchestra/schema";

export type AutosaveStatus =
  | "loading"
  | "clean"
  | "dirty"
  | "saving"
  | "saved"
  | "error"
  | "conflict"
  | "blocked";

export type SaveOutcome =
  | { ok: true; etag: string; validation: ValidationReport }
  | { ok: false; kind: "conflict"; message: string; currentEtag: string | null }
  | { ok: false; kind: "error"; message: string; code: string | null };

export interface SaveRequest {
  docId: string;
  workflow: WorkflowFile;
  baseEtag: string;
  revision: number;
  signal: AbortSignal;
}

export type SaveFn = (request: SaveRequest) => Promise<SaveOutcome>;

export interface AutosaveSnapshot {
  docId: string;
  status: AutosaveStatus;
  revision: number;
  savedRevision: number;
  etag: string | null;
  error: string | null;
  errorCode: string | null;
  conflictEtag: string | null;
  blocked: boolean;
  blockedReason: string | null;
  lastSavedAt: number | null;
}

export interface AutosaveOptions {
  docId: string;
  save: SaveFn;
  contentDebounceMs?: number;
  /** Layout-only edits are batched for longer; P3 documents this as 5 s. */
  layoutDebounceMs?: number;
  now?: () => number;
}

export const CONTENT_DEBOUNCE_MS = 600;
export const LAYOUT_DEBOUNCE_MS = 5_000;

interface InFlight {
  revision: number;
  controller: AbortController;
  promise: Promise<boolean>;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return "The save failed.";
}

export class WorkflowAutosave {
  readonly #docId: string;
  readonly #save: SaveFn;
  readonly #contentDebounceMs: number;
  readonly #layoutDebounceMs: number;
  readonly #now: () => number;
  readonly #listeners = new Set<(snapshot: AutosaveSnapshot) => void>();

  #payload: WorkflowFile | null = null;
  #revision = 0;
  #savedRevision = 0;
  #etag: string | null = null;
  #status: AutosaveStatus = "loading";
  #error: string | null = null;
  #errorCode: string | null = null;
  #conflictEtag: string | null = null;
  #blocked = false;
  #blockedReason: string | null = null;
  #lastSavedAt: number | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight: InFlight | null = null;
  #generation = 0;
  #disposed = false;
  #snapshot: AutosaveSnapshot;

  constructor(options: AutosaveOptions) {
    this.#docId = options.docId;
    this.#save = options.save;
    this.#contentDebounceMs = options.contentDebounceMs ?? CONTENT_DEBOUNCE_MS;
    this.#layoutDebounceMs = options.layoutDebounceMs ?? LAYOUT_DEBOUNCE_MS;
    this.#now = options.now ?? Date.now;
    this.#snapshot = this.#buildSnapshot();
  }

  get docId(): string {
    return this.#docId;
  }

  getSnapshot = (): AutosaveSnapshot => this.#snapshot;

  subscribe = (listener: (snapshot: AutosaveSnapshot) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Load or reload a server document. Manufactures no undo entry. */
  reset(input: { workflow: WorkflowFile; etag: string; revision?: number }): void {
    if (this.#disposed) return;
    this.#clearTimer();
    this.#abortInFlight();
    this.#generation += 1;
    this.#payload = input.workflow;
    this.#etag = input.etag;
    this.#revision = input.revision ?? 0;
    this.#savedRevision = input.revision ?? 0;
    this.#status = "clean";
    this.#error = null;
    this.#errorCode = null;
    this.#conflictEtag = null;
    this.#lastSavedAt = null;
    this.#blocked = false;
    this.#blockedReason = null;
    this.#emit();
  }

  /** Record a local edit. The current form is never replaced by a save ack. */
  change(workflow: WorkflowFile, options: { layoutOnly: boolean }): void {
    if (this.#disposed) return;
    this.#payload = workflow;
    this.#revision += 1;
    if (this.#status === "conflict") {
      this.#emit();
      return;
    }
    if (this.#status !== "saving" && this.#status !== "error") {
      this.#status = this.#inFlight === null ? "dirty" : "saving";
    }
    this.#emit();
    if (!this.#blocked && this.#status !== "error") {
      this.#schedule(options.layoutOnly);
    }
  }

  /** Blocking is an overlay; it never erases a conflict or error phase. */
  setBlocked(blocked: boolean, reason?: string): void {
    if (this.#disposed) return;
    if (this.#blocked === blocked) return;
    this.#blocked = blocked;
    this.#blockedReason = blocked ? (reason ?? "The editor has an invalid form buffer.") : null;
    if (blocked) {
      this.#clearTimer();
      this.#emit();
      return;
    }
    this.#emit();
    if (
      this.#status === "dirty" &&
      this.#revision > this.#savedRevision &&
      this.#inFlight === null
    ) {
      this.#schedule(false);
    }
  }

  /** Explicit save; resolves true only when every locally known edit is saved. */
  async saveNow(): Promise<boolean> {
    this.#clearTimer();
    if (this.#disposed) return false;
    if (this.#blocked || this.#status === "conflict") return false;
    while (!this.#disposed) {
      if (this.#inFlight !== null) {
        await this.#inFlight.promise.catch(() => false);
        if (this.#disposed || this.#blocked) return false;
        if (this.#phaseStatus() === "conflict" || this.#phaseStatus() === "error") return false;
        continue;
      }
      if (this.#revision <= this.#savedRevision) return true;
      const ok = await this.#runSave();
      if (!ok) return false;
    }
    return false;
  }

  async retry(): Promise<boolean> {
    if (this.#disposed || this.#status === "conflict" || this.#blocked) return false;
    if (this.#payload === null || this.#etag === null) return false;
    this.#error = null;
    this.#errorCode = null;
    this.#status = this.#revision > this.#savedRevision ? "dirty" : "clean";
    this.#emit();
    return this.saveNow();
  }

  /**
   * Adopt a freshly read ETag for an explicit overwrite. Never uses `If-Match: *`;
   * a second 409 leaves the controller in the conflict state again.
   */
  setBaseEtag(etag: string): void {
    if (this.#disposed) return;
    this.#etag = etag;
    if (this.#status === "conflict" || this.#status === "error") {
      this.#conflictEtag = null;
      this.#error = null;
      this.#errorCode = null;
      this.#status = this.#revision > this.#savedRevision ? "dirty" : "clean";
      this.#emit();
    }
  }

  /** Re-arm after a React StrictMode effect replay; real unmounts stay disposed. */
  activate(): void {
    if (!this.#disposed) return;
    this.#disposed = false;
    this.#generation += 1;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#clearTimer();
    this.#abortInFlight();
    this.#listeners.clear();
  }

  #schedule(layoutOnly: boolean): void {
    this.#clearTimer();
    if (this.#disposed || this.#blocked || this.#status === "conflict") return;
    const delay = layoutOnly ? this.#layoutDebounceMs : this.#contentDebounceMs;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#flush();
    }, delay);
  }

  async #flush(): Promise<void> {
    if (this.#disposed || this.#blocked || this.#status === "conflict") return;
    if (this.#inFlight !== null) return;
    if (this.#revision <= this.#savedRevision) return;
    const ok = await this.#runSave();
    if (ok && !this.#disposed && this.#revision > this.#savedRevision) {
      void this.#flush();
    }
  }

  #runSave(): Promise<boolean> {
    if (this.#payload === null) return Promise.resolve(false);
    if (this.#etag === null) {
      this.#status = "error";
      this.#error = "The workflow document is not loaded yet.";
      this.#emit();
      return Promise.resolve(false);
    }
    const capturedRevision = this.#revision;
    const capturedPayload = this.#payload;
    const capturedEtag = this.#etag;
    const generation = this.#generation;
    const controller = new AbortController();
    this.#status = "saving";
    this.#emit();
    const promise = Promise.resolve().then(() =>
      this.#executeSave(capturedRevision, capturedPayload, capturedEtag, controller, generation),
    );
    this.#inFlight = { revision: capturedRevision, controller, promise };
    return promise;
  }

  async #executeSave(
    capturedRevision: number,
    capturedPayload: WorkflowFile,
    capturedEtag: string,
    controller: AbortController,
    generation: number,
  ): Promise<boolean> {
    let outcome: SaveOutcome;
    try {
      outcome = await this.#save({
        docId: this.#docId,
        workflow: capturedPayload,
        baseEtag: capturedEtag,
        revision: capturedRevision,
        signal: controller.signal,
      });
    } catch (error) {
      outcome = { ok: false, kind: "error", message: messageOf(error), code: null };
    }
    if (this.#disposed || generation !== this.#generation) return false;
    if (this.#inFlight?.controller === controller) this.#inFlight = null;

    if (outcome.ok) {
      if (capturedRevision > this.#savedRevision) {
        this.#savedRevision = capturedRevision;
        this.#etag = outcome.etag;
      }
      this.#lastSavedAt = this.#now();
      this.#error = null;
      this.#errorCode = null;
      this.#conflictEtag = null;
      if (this.#revision > this.#savedRevision) {
        this.#status = "dirty";
        this.#emit();
        if (!this.#blocked) void this.#flush();
      } else {
        this.#status = "saved";
        this.#emit();
      }
      return true;
    }

    if (outcome.kind === "conflict") {
      this.#status = "conflict";
      this.#conflictEtag = outcome.currentEtag;
      this.#error = outcome.message;
      this.#errorCode = "E_CONFLICT";
    } else {
      this.#status = "error";
      this.#error = outcome.message;
      this.#errorCode = outcome.code;
    }
    this.#emit();
    return false;
  }

  #phaseStatus(): AutosaveStatus {
    return this.#status;
  }

  #abortInFlight(): void {
    if (this.#inFlight !== null) {
      this.#inFlight.controller.abort();
      this.#inFlight = null;
    }
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #buildSnapshot(): AutosaveSnapshot {
    return {
      docId: this.#docId,
      status: this.#blocked ? "blocked" : this.#status,
      revision: this.#revision,
      savedRevision: this.#savedRevision,
      etag: this.#etag,
      error: this.#error,
      errorCode: this.#errorCode,
      conflictEtag: this.#conflictEtag,
      blocked: this.#blocked,
      blockedReason: this.#blockedReason,
      lastSavedAt: this.#lastSavedAt,
    };
  }

  #emit(): void {
    this.#snapshot = this.#buildSnapshot();
    for (const listener of this.#listeners) listener(this.#snapshot);
  }
}

export function isDirty(snapshot: AutosaveSnapshot): boolean {
  return snapshot.revision > snapshot.savedRevision;
}

export function canRun(snapshot: AutosaveSnapshot): boolean {
  return (
    !snapshot.blocked &&
    snapshot.status !== "conflict" &&
    snapshot.status !== "error" &&
    snapshot.status !== "blocked" &&
    snapshot.status !== "loading"
  );
}

import type { CatalogCli, CliModelCatalog, CliModelCatalogClient } from "./catalog.js";

export type CatalogLoading = "idle" | "load" | "refresh";

export interface CatalogEntry {
  catalog: CliModelCatalog | null;
  loadedAt: number | null;
  error: string | null;
  loading: CatalogLoading;
  inflight: Promise<void> | null;
  controller: AbortController | null;
  sequence: number;
  /** Set once the one automatic discovery for an empty server cache has been started. */
  autoDiscovered: boolean;
}

export interface CatalogRequest {
  projectId: string;
  cli: CatalogCli;
  client: CliModelCatalogClient;
  loadTimeoutMs: number;
  refreshTimeoutMs: number;
}

export const FRESH_MS = 60_000;

export const IDLE_ENTRY: CatalogEntry = {
  catalog: null,
  loadedAt: null,
  error: null,
  loading: "idle",
  inflight: null,
  controller: null,
  sequence: 0,
  autoDiscovered: false,
};

const entries = new Map<string, CatalogEntry>();
const listeners = new Map<string, Set<() => void>>();

export function catalogKey(projectId: string, cli: CatalogCli): string {
  return `${projectId}\u0000${cli}`;
}

export function getEntry(key: string): CatalogEntry {
  return entries.get(key) ?? IDLE_ENTRY;
}

export function subscribe(key: string, listener: () => void): () => void {
  const subscribers = listeners.get(key) ?? new Set<() => void>();
  subscribers.add(listener);
  listeners.set(key, subscribers);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size > 0 || listeners.get(key) !== subscribers) return;
    listeners.delete(key);
    abandon(key);
  };
}

export function clearCliModelCatalogCache(): void {
  for (const entry of entries.values()) entry.controller?.abort();
  entries.clear();
  listeners.clear();
}

// Fetches only when nothing is in flight and the cached catalog is missing or older than FRESH_MS.
// A stale catalog stays visible while the revalidation runs.
export function ensureCatalog(key: string, request: CatalogRequest): void {
  const entry = getEntry(key);
  if (entry.inflight !== null) return;
  if (entry.loadedAt !== null && Date.now() - entry.loadedAt < FRESH_MS) return;
  startRequest(key, "load", request);
}

export function startRequest(key: string, mode: "load" | "refresh", request: CatalogRequest): void {
  const { projectId, cli, client } = request;
  const previous = getEntry(key);
  previous.controller?.abort();
  const controller = new AbortController();
  const sequence = previous.sequence + 1;
  update(key, { sequence, controller, loading: mode, error: null });

  const fail = (error: unknown, timedOut: boolean) => {
    if (getEntry(key).sequence !== sequence) return;
    update(key, {
      loading: "idle",
      error: errorMessage(error, timedOut),
      controller: null,
      inflight: null,
    });
  };

  let call: Promise<CliModelCatalog>;
  try {
    call =
      mode === "load"
        ? client.getCliModels(projectId, cli, { signal: controller.signal })
        : client.refreshCliModels(projectId, cli, { signal: controller.signal });
  } catch (error) {
    fail(error, false);
    return;
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
        reject(new Error("Model catalog deadline exceeded."));
      },
      mode === "load" ? request.loadTimeoutMs : request.refreshTimeoutMs,
    );
  });

  const settled = Promise.race([call, deadline])
    .then(
      (catalog) => {
        if (getEntry(key).sequence !== sequence) return;
        if (catalog.projectId !== projectId || catalog.cli !== cli) {
          fail(new Error("The model catalog response did not match this CLI and project."), false);
          return;
        }
        update(key, {
          catalog,
          loadedAt: Date.now(),
          loading: "idle",
          error: null,
          controller: null,
          inflight: null,
        });
        // The server's GET only reads its cache; discovery runs on refresh. When nothing has
        // been cached yet, discover once automatically instead of showing a failure.
        if (mode === "load" && !getEntry(key).autoDiscovered && nothingCachedYet(catalog)) {
          update(key, { autoDiscovered: true });
          startRequest(key, "refresh", request);
        }
      },
      (error: unknown) => fail(error, timedOut),
    )
    .finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  update(key, { inflight: settled });
}

function nothingCachedYet(catalog: CliModelCatalog): boolean {
  return (
    catalog.status === "unavailable" &&
    catalog.fetchedAt === null &&
    catalog.items.length === 0 &&
    catalog.source === "none"
  );
}

// Called when the last subscriber for a key leaves: drop the request and ignore its late reply.
function abandon(key: string): void {
  const entry = getEntry(key);
  if (entry.controller === null) return;
  entry.controller.abort();
  update(key, {
    sequence: entry.sequence + 1,
    controller: null,
    inflight: null,
    loading: "idle",
  });
}

function update(key: string, patch: Partial<CatalogEntry>): void {
  entries.set(key, { ...getEntry(key), ...patch });
  for (const listener of listeners.get(key) ?? []) listener();
}

function errorMessage(error: unknown, timedOut: boolean): string {
  if (timedOut) {
    return "The model catalog request timed out. Use the CLI default or a custom model ID.";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "The model catalog request was cancelled.";
  }
  return "Model discovery is unavailable. Use the CLI default or a custom model ID.";
}

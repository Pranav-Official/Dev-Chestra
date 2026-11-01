import { getProvider } from "@devchestra/adapters";
import type { CatalogCli, ProviderStatusItem } from "@devchestra/api";
import { PROD_CLIS } from "@devchestra/schema";

export interface ProbeOutcome {
  ok: boolean;
  version: string | null;
  detail?: string;
}

export interface ProviderStatusOptions {
  probe?: (cli: CatalogCli, signal: AbortSignal) => Promise<ProbeOutcome>;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

export interface ProviderStatusService {
  getAll(): Promise<ProviderStatusItem[]>;
  probe(cli: CatalogCli, opts?: { fresh?: boolean }): Promise<ProviderStatusItem>;
}

const NOT_INSTALLED = /ENOENT|not found|no such file|command not found/i;
const DETAIL_LIMIT = 200;
const TIMEOUT_DETAIL = "Version check timed out.";
const FAILED_DETAIL = "Version check failed.";

/** Drops control characters and clips, so a probe message stays one short line. */
function cleanDetail(detail: string | undefined): string {
  const kept = Array.from(detail ?? "").filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code > 0x1f && code !== 0x7f;
  });
  return kept.slice(0, DETAIL_LIMIT).join("").trim();
}

function toStatus(cli: CatalogCli, outcome: ProbeOutcome, checkedAt: number): ProviderStatusItem {
  if (outcome.ok) {
    return { id: cli, state: "ready", version: outcome.version, checkedAt };
  }
  if (NOT_INSTALLED.test(outcome.detail ?? "")) {
    return { id: cli, state: "notInstalled", version: null, checkedAt };
  }
  const detail = cleanDetail(outcome.detail);
  return {
    id: cli,
    state: "error",
    version: null,
    checkedAt,
    detail: detail === "" ? FAILED_DETAIL : detail,
  };
}

/**
 * Cached `--version` probes for the provider CLIs. A probe never throws: a
 * crash, timeout or missing binary becomes a status item.
 */
export function createProviderStatusService(
  options: ProviderStatusOptions = {},
): ProviderStatusService {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const ttlMs = options.ttlMs ?? 600_000;
  const now = options.now ?? Date.now;
  const probeCli =
    options.probe ??
    ((cli: CatalogCli, signal: AbortSignal) =>
      getProvider(cli).adapter().probe({ timeoutMs }, signal));

  const cache = new Map<CatalogCli, { status: ProviderStatusItem; expiresAt: number }>();
  const inflight = new Map<CatalogCli, Promise<ProviderStatusItem>>();

  async function runProbe(cli: CatalogCli): Promise<ProbeOutcome> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<ProbeOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, version: null, detail: TIMEOUT_DETAIL });
      }, timeoutMs);
    });
    try {
      return await Promise.race([probeCli(cli, controller.signal), timedOut]);
    } catch (error) {
      return {
        ok: false,
        version: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function start(cli: CatalogCli): Promise<ProviderStatusItem> {
    const promise: Promise<ProviderStatusItem> = runProbe(cli)
      .then((outcome) => {
        const status = toStatus(cli, outcome, now());
        cache.set(cli, { status, expiresAt: status.checkedAt + ttlMs });
        return status;
      })
      .finally(() => {
        if (inflight.get(cli) === promise) inflight.delete(cli);
      });
    inflight.set(cli, promise);
    return promise;
  }

  async function probe(
    cli: CatalogCli,
    opts: { fresh?: boolean } = {},
  ): Promise<ProviderStatusItem> {
    if (opts.fresh === true) return start(cli);
    const cached = cache.get(cli);
    if (cached !== undefined && now() < cached.expiresAt) return cached.status;
    return inflight.get(cli) ?? start(cli);
  }

  return {
    getAll: () => Promise.all(PROD_CLIS.map((cli) => probe(cli))),
    probe,
  };
}

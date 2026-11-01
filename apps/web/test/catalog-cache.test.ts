import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CatalogCli,
  CliModelCatalog,
  CliModelCatalogClient,
  CliModelRequestOptions,
} from "../src/editor/inspector/model/catalog.js";
import { clearCliModelCatalogCache } from "../src/editor/inspector/model/catalogCache.js";
import { useCliModelCatalog } from "../src/editor/inspector/model/useCliModelCatalog.js";

function catalog(cli: CatalogCli, projectId = "p1", cliVersion = "1.2.3"): CliModelCatalog {
  return {
    cli,
    projectId,
    status: "ready",
    scope: "devchestra-runtime",
    source: "codex-app-server",
    cliVersion,
    items: [{ id: `${cli}-model`, label: `${cli} model`, source: "codex-app-server" }],
    fetchedAt: 1,
    expiresAt: 2,
    truncated: false,
    customSupported: true,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function hanging(options: CliModelRequestOptions | undefined): Promise<CliModelCatalog> {
  return new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });
}

function fakeClient() {
  const get = vi.fn();
  const refresh = vi.fn();
  const client: CliModelCatalogClient = {
    getCliModels: get as CliModelCatalogClient["getCliModels"],
    refreshCliModels: refresh as CliModelCatalogClient["refreshCliModels"],
  };
  return { client, get, refresh };
}

function openCatalog(client: CliModelCatalogClient, cli: CatalogCli = "codex", projectId = "p1") {
  return renderHook(() => useCliModelCatalog({ projectId, cli, open: true, client }));
}

describe("shared model catalog cache", () => {
  beforeEach(() => {
    clearCliModelCatalogCache();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the cached list at once and does not refetch within a minute", async () => {
    const fake = fakeClient();
    fake.get.mockResolvedValue(catalog("codex"));
    const first = openCatalog(fake.client);
    await waitFor(() => expect(first.result.current.catalog?.cli).toBe("codex"));
    first.unmount();

    vi.setSystemTime(new Date("2026-01-01T00:00:59Z"));
    const second = openCatalog(fake.client);
    expect(second.result.current.catalog?.cli).toBe("codex");
    expect(second.result.current.loading).toBe("idle");
    expect(fake.get).toHaveBeenCalledTimes(1);
  });

  it("makes one request when two nodes open at the same time", async () => {
    const fake = fakeClient();
    const pending = deferred<CliModelCatalog>();
    fake.get.mockReturnValue(pending.promise);
    const first = openCatalog(fake.client);
    const second = openCatalog(fake.client);
    expect(fake.get).toHaveBeenCalledTimes(1);
    expect(first.result.current.loading).toBe("load");
    expect(second.result.current.loading).toBe("load");

    await act(async () => {
      pending.resolve(catalog("codex"));
      await pending.promise;
    });
    await waitFor(() => expect(second.result.current.catalog?.cli).toBe("codex"));
    expect(first.result.current.catalog?.cli).toBe("codex");
    expect(fake.get).toHaveBeenCalledTimes(1);
  });

  it("keeps the request while another node still waits on it", async () => {
    const fake = fakeClient();
    const pending = deferred<CliModelCatalog>();
    let signal: AbortSignal | undefined;
    fake.get.mockImplementation((_project, _cli, options) => {
      signal = options?.signal;
      return pending.promise;
    });
    const first = openCatalog(fake.client);
    const second = openCatalog(fake.client);

    first.unmount();
    expect(signal?.aborted).toBe(false);

    await act(async () => {
      pending.resolve(catalog("codex"));
      await pending.promise;
    });
    await waitFor(() => expect(second.result.current.catalog?.cli).toBe("codex"));
  });

  it("aborts the request when the last node for the key leaves", () => {
    const fake = fakeClient();
    let signal: AbortSignal | undefined;
    fake.get.mockImplementation((_project, _cli, options) => {
      signal = options?.signal;
      return hanging(options);
    });
    const first = openCatalog(fake.client);
    const second = openCatalog(fake.client);

    first.unmount();
    expect(signal?.aborted).toBe(false);
    second.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("shows a stale catalog at once and revalidates it in the background", async () => {
    const fake = fakeClient();
    fake.get.mockResolvedValue(catalog("codex", "p1", "1.0.0"));
    const first = openCatalog(fake.client);
    await waitFor(() => expect(first.result.current.catalog?.cliVersion).toBe("1.0.0"));
    first.unmount();

    vi.setSystemTime(new Date("2026-01-01T00:01:01Z"));
    const revalidated = deferred<CliModelCatalog>();
    fake.get.mockReturnValue(revalidated.promise);
    const second = openCatalog(fake.client);
    expect(second.result.current.catalog?.cliVersion).toBe("1.0.0");
    expect(second.result.current.loading).toBe("load");
    expect(fake.get).toHaveBeenCalledTimes(2);

    await act(async () => {
      revalidated.resolve(catalog("codex", "p1", "2.0.0"));
      await revalidated.promise;
    });
    await waitFor(() => expect(second.result.current.catalog?.cliVersion).toBe("2.0.0"));
    expect(second.result.current.loading).toBe("idle");
    expect(fake.get).toHaveBeenCalledTimes(2);
  });

  it("replaces the cache on refresh and updates every node", async () => {
    const fake = fakeClient();
    fake.get.mockResolvedValue(catalog("codex", "p1", "1.0.0"));
    const first = openCatalog(fake.client);
    const second = openCatalog(fake.client);
    await waitFor(() => expect(second.result.current.catalog?.cliVersion).toBe("1.0.0"));

    fake.refresh.mockResolvedValue(catalog("codex", "p1", "3.0.0"));
    act(() => first.result.current.refresh());
    await waitFor(() => expect(first.result.current.catalog?.cliVersion).toBe("3.0.0"));
    await waitFor(() => expect(second.result.current.catalog?.cliVersion).toBe("3.0.0"));
    expect(fake.get).toHaveBeenCalledTimes(1);
    expect(fake.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps a stale catalog and sets an error when revalidation fails", async () => {
    const fake = fakeClient();
    fake.get.mockResolvedValue(catalog("codex"));
    const first = openCatalog(fake.client);
    await waitFor(() => expect(first.result.current.catalog?.cli).toBe("codex"));
    first.unmount();

    vi.setSystemTime(new Date("2026-01-01T00:01:01Z"));
    fake.get.mockRejectedValue(new Error("offline"));
    const second = openCatalog(fake.client);
    await waitFor(() => expect(second.result.current.error).not.toBeNull());
    expect(second.result.current.catalog?.cli).toBe("codex");
    expect(second.result.current.loading).toBe("idle");
  });

  it("keeps each CLI and project in its own entry", async () => {
    const fake = fakeClient();
    fake.get.mockImplementation((project: string, cli: CatalogCli) =>
      Promise.resolve(catalog(cli, project)),
    );
    const codex = openCatalog(fake.client, "codex", "p1");
    const claude = openCatalog(fake.client, "claude-code", "p1");
    const otherProject = openCatalog(fake.client, "codex", "p2");

    await waitFor(() => expect(claude.result.current.catalog?.cli).toBe("claude-code"));
    await waitFor(() => expect(otherProject.result.current.catalog?.projectId).toBe("p2"));
    expect(codex.result.current.catalog?.projectId).toBe("p1");
    expect(codex.result.current.catalog?.cli).toBe("codex");
    expect(fake.get).toHaveBeenCalledTimes(3);
  });
});

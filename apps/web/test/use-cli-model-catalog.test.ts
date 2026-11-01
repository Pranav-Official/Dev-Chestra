import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CatalogCli,
  CliModelCatalog,
  CliModelCatalogClient,
  CliModelRequestOptions,
} from "../src/editor/inspector/model/catalog.js";
import { clearCliModelCatalogCache } from "../src/editor/inspector/model/catalogCache.js";
import { useCliModelCatalog } from "../src/editor/inspector/model/useCliModelCatalog.js";

function catalog(cli: CatalogCli, projectId = "p1"): CliModelCatalog {
  return {
    cli,
    projectId,
    status: "ready",
    scope: "devchestra-runtime",
    source: "codex-app-server",
    cliVersion: "1.2.3",
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

interface FakeClient {
  client: CliModelCatalogClient;
  get: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
}

function fakeClient(): FakeClient {
  const get = vi.fn();
  const refresh = vi.fn();
  return {
    client: {
      getCliModels: get as CliModelCatalogClient["getCliModels"],
      refreshCliModels: refresh as CliModelCatalogClient["refreshCliModels"],
    },
    get,
    refresh,
  };
}

function hanging(options: CliModelRequestOptions | undefined): Promise<CliModelCatalog> {
  return new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });
}

describe("useCliModelCatalog", () => {
  beforeEach(() => {
    clearCliModelCatalogCache();
  });

  it("loads only when opened and refreshes only on explicit action", async () => {
    const fake = fakeClient();
    fake.get.mockResolvedValue(catalog("codex"));
    const { result, rerender } = renderHook(
      (props: { open: boolean }) =>
        useCliModelCatalog({
          projectId: "p1",
          cli: "codex",
          open: props.open,
          client: fake.client,
        }),
      { initialProps: { open: false } },
    );
    expect(fake.get).not.toHaveBeenCalled();
    expect(fake.refresh).not.toHaveBeenCalled();

    rerender({ open: true });
    await waitFor(() => expect(result.current.catalog?.cli).toBe("codex"));
    expect(fake.get).toHaveBeenCalledWith("p1", "codex", { signal: expect.any(AbortSignal) });
    expect(fake.refresh).not.toHaveBeenCalled();

    rerender({ open: true });
    expect(fake.get).toHaveBeenCalledTimes(1);

    fake.refresh.mockResolvedValue(catalog("codex"));
    act(() => result.current.refresh());
    await waitFor(() => expect(fake.refresh).toHaveBeenCalledTimes(1));
  });

  it("ignores a late response after the CLI changes", async () => {
    const fake = fakeClient();
    const codex = deferred<CliModelCatalog>();
    const claude = deferred<CliModelCatalog>();
    fake.get.mockImplementation((_project: string, cli: CatalogCli) =>
      cli === "codex" ? codex.promise : claude.promise,
    );

    const { result, rerender } = renderHook(
      (props: { cli: CatalogCli }) =>
        useCliModelCatalog({
          projectId: "p1",
          cli: props.cli,
          open: true,
          client: fake.client,
        }),
      { initialProps: { cli: "codex" as CatalogCli } },
    );

    rerender({ cli: "claude-code" });
    await waitFor(() => expect(fake.get).toHaveBeenCalledTimes(2));
    await act(async () => {
      claude.resolve(catalog("claude-code"));
      await claude.promise;
    });
    await waitFor(() => expect(result.current.catalog?.cli).toBe("claude-code"));

    await act(async () => {
      codex.resolve(catalog("codex"));
      await codex.promise;
    });
    expect(result.current.catalog?.cli).toBe("claude-code");
  });

  it("fences late responses across project keys", async () => {
    const fake = fakeClient();
    const first = deferred<CliModelCatalog>();
    const second = deferred<CliModelCatalog>();
    fake.get.mockImplementation((project: string) =>
      project === "p1" ? first.promise : second.promise,
    );
    const { result, rerender } = renderHook(
      (props: { projectId: string }) =>
        useCliModelCatalog({
          projectId: props.projectId,
          cli: "codex",
          open: true,
          client: fake.client,
        }),
      { initialProps: { projectId: "p1" } },
    );

    rerender({ projectId: "p2" });
    await waitFor(() => expect(fake.get).toHaveBeenCalledTimes(2));
    await act(async () => {
      second.resolve(catalog("codex", "p2"));
      await second.promise;
    });
    await waitFor(() => expect(result.current.catalog?.projectId).toBe("p2"));

    await act(async () => {
      first.resolve(catalog("codex", "p1"));
      await first.promise;
    });
    expect(result.current.catalog?.projectId).toBe("p2");
    expect(result.current.catalog?.projectId).not.toBe("p1");
  });

  it("keeps the last catalog when a refresh fails", async () => {
    const fake = fakeClient();
    fake.get.mockResolvedValue(catalog("codex"));
    fake.refresh.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() =>
      useCliModelCatalog({
        projectId: "p1",
        cli: "codex",
        open: true,
        client: fake.client,
      }),
    );
    await waitFor(() => expect(result.current.catalog?.status).toBe("ready"));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.catalog?.status).toBe("ready");
    expect(result.current.loading).toBe("idle");
  });

  it("bounds a hanging request instead of spinning forever", async () => {
    const fake = fakeClient();
    fake.get.mockImplementation((_project, _cli, options) => hanging(options));
    const { result } = renderHook(() =>
      useCliModelCatalog({
        projectId: "p1",
        cli: "codex",
        open: true,
        client: fake.client,
        loadTimeoutMs: 20,
      }),
    );
    await waitFor(() => expect(result.current.error).toContain("timed out"), { timeout: 1_000 });
    expect(result.current.loading).toBe("idle");
    expect(result.current.catalog).toBeNull();
  });

  it("settles a synchronous client failure instead of leaving a spinner", async () => {
    const fake = fakeClient();
    fake.get.mockImplementation(() => {
      throw new Error("missing client method");
    });
    const { result } = renderHook(() =>
      useCliModelCatalog({
        projectId: "p1",
        cli: "codex",
        open: true,
        client: fake.client,
      }),
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.loading).toBe("idle");
  });

  it("keeps a closed refresh pending visible and aborts it when the CLI key changes", async () => {
    const fake = fakeClient();
    fake.get.mockResolvedValue(catalog("codex"));
    let signal: AbortSignal | undefined;
    const aborted = vi.fn();
    fake.refresh.mockImplementation((_project, _cli, options) => {
      signal = options?.signal;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted();
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    const { result, rerender } = renderHook(
      (props: { cli: CatalogCli }) =>
        useCliModelCatalog({
          projectId: "p1",
          cli: props.cli,
          open: false,
          client: fake.client,
        }),
      { initialProps: { cli: "codex" as CatalogCli } },
    );

    act(() => result.current.refresh());
    expect(result.current.loading).toBe("refresh");
    rerender({ cli: "claude-code" });
    expect(signal?.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe("idle");
  });

  it("bounds refresh with its own deadline and fences a late response", async () => {
    const fake = fakeClient();
    const late = deferred<CliModelCatalog>();
    fake.get.mockResolvedValue(catalog("codex"));
    fake.refresh.mockImplementation(() => late.promise);
    const { result } = renderHook(() =>
      useCliModelCatalog({
        projectId: "p1",
        cli: "codex",
        open: true,
        client: fake.client,
        refreshTimeoutMs: 20,
      }),
    );
    await waitFor(() => expect(result.current.catalog?.status).toBe("ready"));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error).toContain("timed out"), { timeout: 1_000 });
    expect(result.current.loading).toBe("idle");

    await act(async () => {
      late.resolve({ ...catalog("codex"), status: "ready" });
      await late.promise;
    });
    expect(result.current.catalog?.status).toBe("ready");
    expect(result.current.error).toContain("timed out");
  });

  it("does not request without a project id", () => {
    const fake = fakeClient();
    renderHook(() =>
      useCliModelCatalog({
        projectId: undefined,
        cli: "codex",
        open: true,
        client: fake.client,
      }),
    );
    expect(fake.get).not.toHaveBeenCalled();
  });
});

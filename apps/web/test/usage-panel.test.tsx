import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../src/pages/SettingsPage.js";

vi.mock("../src/api/hooks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/hooks.js")>()),
  useBootstrap: () => ({ data: { projects: [{ id: "p-1", name: "Devfluencer" }] } }),
}));

const SUMMARY = {
  total: { usd: 17.13, tokens: 4_820_500 },
  byProvider: [
    {
      provider: "claude-code",
      usd: 15.5,
      tokens: 400_000,
      byModel: [{ model: "claude-haiku-5-5", usd: 15.5, tokens: 400_000 }],
    },
    {
      provider: "pi",
      usd: 1.63,
      tokens: 4_420_500,
      byModel: [{ model: "opencode-go/muse-spark-1.3-contributor", usd: 1.63, tokens: 4_420_500 }],
    },
  ],
};

function stubUsageApi() {
  const fetchMock = vi.fn(async () => Response.json(SUMMARY));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings/usage" element={<SettingsPage />} />
          <Route path="/p/:pid/settings/usage" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("Usage settings page", () => {
  it("renders stats, provider bars and the cost breakdown across all projects", async () => {
    const fetchMock = stubUsageApi();
    renderAt("/settings/usage");
    expect(await screen.findByRole("heading", { name: "Tokens by provider" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Cost by model" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Cost by model donut chart" })).toBeInTheDocument();
    expect(screen.getByText("4,820,500")).toBeInTheDocument();
    expect(screen.getByText("Showing usage across all projects.")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Usage scope" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/usage", expect.anything());
  });

  it("says when it is showing one project and links back to all projects", async () => {
    const fetchMock = stubUsageApi();
    renderAt("/p/p-1/settings/usage");
    await screen.findByRole("heading", { name: "Tokens by provider" });
    const scope = screen.getByRole("navigation", { name: "Usage scope" });
    expect(scope).toHaveTextContent("All projects");
    const all = screen.getByRole("link", { name: "All projects" });
    expect(all).toHaveAttribute("href", "/settings/usage");
    expect(all).not.toHaveAttribute("aria-current");
    const current = screen.getByRole("link", { name: "Devfluencer" });
    expect(current).toHaveAttribute("href", "/p/p-1/settings/usage");
    expect(current).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText("Showing usage across all projects.")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/usage?scope=project&projectId=p-1",
      expect.anything(),
    );
  });
});

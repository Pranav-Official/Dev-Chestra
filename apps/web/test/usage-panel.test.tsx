import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../src/pages/SettingsPage.js";

const provider = (name: string, usd: number, tokens: number, model = "m") => ({
  provider: name,
  usd,
  tokens,
  byModel: [{ model, usd, tokens }],
});

const SUMMARY = {
  total: { usd: 17.13, tokens: 16_000_000 },
  byProvider: [
    provider("claude-code", 15.5, 400_000, "claude-haiku-5-5"),
    provider("pi", 1.63, 5_600_000, "opencode-go/muse-spark-1.3-contributor"),
    provider("codex", 0, 10_000_000, "gpt-6-luna"),
  ],
  byProject: [
    {
      projectId: "p-job",
      name: "Job Hunt",
      removed: false,
      usd: 12.1,
      tokens: 2_900_000,
      byProvider: [provider("claude-code", 11.9, 300_000), provider("opencode", 0.2, 2_600_000)],
    },
    {
      projectId: "p-devchestra",
      name: "DevChestra",
      removed: false,
      usd: 4.0,
      tokens: 12_000_000,
      byProvider: [provider("claude-code", 3.6, 100_000), provider("codex", 0, 10_000_000)],
    },
    {
      projectId: "p-old",
      name: "Resume Gen",
      removed: true,
      usd: 1.03,
      tokens: 1_100_000,
      byProvider: [provider("pi", 1.03, 1_100_000)],
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
  it("shows overall usage, including the provider and model breakdown", async () => {
    stubUsageApi();
    renderAt("/settings/usage");
    expect(await screen.findByRole("heading", { name: "Tokens by provider" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Cost by model" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Cost by model donut chart" })).toBeInTheDocument();
    expect(screen.getByText("16,000,000")).toBeInTheDocument();
  });

  it("shows full model identifiers when their final segments match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...SUMMARY,
          byProvider: [
            {
              provider: "pi",
              usd: 2,
              tokens: 200,
              byModel: [
                { model: "first/shared", usd: 1, tokens: 100 },
                { model: "second/shared", usd: 1, tokens: 100 },
              ],
            },
          ],
        }),
      ),
    );
    renderAt("/settings/usage");
    expect(await screen.findByText("pi / first/shared")).toBeInTheDocument();
    expect(screen.getByText("pi / second/shared")).toBeInTheDocument();
  });

  it("shows overall usage even when opened from inside a project", async () => {
    const fetchMock = stubUsageApi();
    renderAt("/p/p-job/settings/usage");
    await screen.findByRole("heading", { name: "Tokens by provider" });
    expect(screen.getByText("16,000,000")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/usage", expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("projectId"),
      expect.anything(),
    );
  });

  it("lists every project, removed ones included, by cost with its share", async () => {
    stubUsageApi();
    renderAt("/settings/usage");
    await screen.findByRole("heading", { name: "Usage by project" });
    expect(screen.getByRole("img", { name: "Usage by project donut chart" })).toBeInTheDocument();
    const rows = screen
      .getAllByRole("button", { pressed: false })
      .filter((b) => b.className.includes("usage-project-row"));
    expect(
      rows.map((row) => within(row).getByText(/Job Hunt|DevChestra|Resume Gen/).textContent),
    ).toEqual(["Job Hunt", "DevChestra", "Resume Gen"]);
    expect(within(rows[0] as HTMLElement).getByText("· 70.6%")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("removed")).toBeInTheDocument();
  });

  it("reorders by tokens when the metric changes", async () => {
    stubUsageApi();
    renderAt("/settings/usage");
    await screen.findByRole("heading", { name: "Usage by project" });
    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));
    expect(screen.getByRole("button", { name: "Tokens" })).toHaveAttribute("aria-pressed", "true");
    const names = screen
      .getAllByRole("button")
      .filter((b) => b.className.includes("usage-project-row"))
      .map((row) => within(row).getByText(/Job Hunt|DevChestra|Resume Gen/).textContent);
    expect(names).toEqual(["DevChestra", "Job Hunt", "Resume Gen"]);
    // The percentage always belongs to the active metric: tokens here, with cost as the quiet column.
    const first = screen
      .getAllByRole("button")
      .filter((b) => b.className.includes("usage-project-row"))[0] as HTMLElement;
    expect(within(first).getByText("12.0M tok")).toBeInTheDocument();
    expect(within(first).getByText("· 75.0%")).toBeInTheDocument();
    expect(within(first).getByText("$4.00")).toBeInTheDocument();
  });

  it("opens a project's provider split on click and clears it", async () => {
    stubUsageApi();
    renderAt("/settings/usage");
    await screen.findByRole("heading", { name: "Usage by project" });
    expect(screen.queryByRole("region", { name: /Provider split/ })).toBeNull();

    const row = screen.getByRole("button", { name: /DevChestra/ });
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-pressed", "true");
    const detail = screen.getByRole("region", { name: "Provider split for DevChestra" });
    expect(within(detail).getByText("DevChestra · providers")).toBeInTheDocument();
    expect(within(detail).getByText("claude-code")).toBeInTheDocument();
    expect(within(detail).getByText("codex")).toBeInTheDocument();
    expect(within(detail).queryByText("opencode")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Job Hunt/ }));
    expect(screen.queryByRole("region", { name: "Provider split for DevChestra" })).toBeNull();
    const second = screen.getByRole("region", { name: "Provider split for Job Hunt" });
    expect(within(second).getByText("opencode")).toBeInTheDocument();

    fireEvent.click(within(second).getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("region", { name: /Provider split/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Job Hunt/ })).toHaveFocus();
  });

  it("keeps a zero-value selection reflected in the chart after changing metrics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ...SUMMARY,
          byProject: [
            ...SUMMARY.byProject,
            {
              projectId: "p-free",
              name: "Free project",
              removed: false,
              usd: 0,
              tokens: 500,
              byProvider: [provider("codex", 0, 500)],
            },
          ],
        }),
      ),
    );
    renderAt("/settings/usage");
    const row = await screen.findByRole("button", { name: /Free project/ });
    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));
    fireEvent.click(row);
    fireEvent.click(screen.getByRole("button", { name: "Cost" }));
    expect(row).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("region", { name: "Provider split for Free project" }),
    ).toBeInTheDocument();
    const chart = screen.getByRole("img", { name: "Usage by project donut chart" });
    expect(chart.querySelectorAll("circle.usage-slice.dim")).toHaveLength(3);
    expect(chart.parentElement).toHaveTextContent("Free project$0.00");
  });

  it("selects a project from its donut slice and toggles it off on a second click", async () => {
    stubUsageApi();
    renderAt("/settings/usage");
    await screen.findByRole("heading", { name: "Usage by project" });
    const slice = screen
      .getByRole("img", { name: "Usage by project donut chart" })
      .querySelector("circle.usage-slice");
    expect(slice).not.toBeNull();
    fireEvent.click(slice as Element);
    expect(screen.getByRole("region", { name: "Provider split for Job Hunt" })).toBeInTheDocument();
    fireEvent.click(slice as Element);
    expect(screen.queryByRole("region", { name: /Provider split/ })).toBeNull();
  });
});

import { PROD_CLIS } from "@devchestra/schema";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderIcon } from "../src/ui/ProviderIcon.js";

describe("ProviderIcon", () => {
  it.each([...PROD_CLIS])("renders a monochrome svg for %s", (cli) => {
    const { container } = render(<ProviderIcon cli={cli} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("data-provider-icon")).toBe(cli);
    expect(svg?.getAttribute("fill")).toBe("currentColor");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.querySelector("path")?.getAttribute("d")?.length).toBeGreaterThan(10);
  });

  it("never references external resources or hardcoded colours", () => {
    for (const cli of PROD_CLIS) {
      const { container, unmount } = render(<ProviderIcon cli={cli} />);
      const markup = container.innerHTML;
      expect(markup).not.toMatch(/https?:\/\/(?!www\.w3\.org)/u);
      expect(markup).not.toContain("<image");
      expect(markup).not.toMatch(/#[0-9a-f]{3,6}/iu);
      unmount();
    }
  });

  it("is labelled, not hidden, when a title is given", () => {
    const { getByRole } = render(<ProviderIcon cli="codex" title="Codex" />);
    expect(getByRole("img", { name: "Codex" })).toBeTruthy();
  });

  it("honours size", () => {
    const { container } = render(<ProviderIcon cli="pi" size={20} />);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("20");
  });

  it("falls back to a generic glyph for unknown ids", () => {
    const { container } = render(<ProviderIcon cli="not-a-cli" />);
    expect(container.querySelector('[data-provider-icon="fallback"]')).not.toBeNull();
  });
});

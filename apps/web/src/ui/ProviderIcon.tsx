/**
 * Monochrome provider marks. Every glyph fills with `currentColor`, so one
 * component serves light and dark themes and every state (normal, selected,
 * turned off) by changing the text colour of the parent.
 *
 * Sources (vendored once, never fetched at runtime; the CSP only allows
 * `img-src 'self' data:`):
 * - Claude Code, Codex, OpenCode: LobeHub Icons, `Mono` variants.
 *   MIT License, Copyright (c) 2023 LobeHub. https://github.com/lobehub/lobe-icons
 * - Pi: the official mark from https://pi.dev/logo-auto.svg, flattened to one colour.
 *
 * The marks belong to their respective owners and are used only to identify the
 * matching integration.
 */
import type { AgentCli } from "@devchestra/schema";
import { Bot } from "lucide-react";
import type { SVGProps } from "react";

interface Glyph {
  viewBox: string;
  d: string;
}

const GLYPHS: Record<AgentCli, Glyph> = {
  "claude-code": {
    viewBox: "0 0 24 24",
    d: "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z",
  },
  codex: {
    viewBox: "0 0 24 24",
    d: "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z",
  },
  opencode: {
    viewBox: "0 0 24 24",
    d: "M16 6H8v12h8V6zm4 16H4V2h16v20z",
  },
  pi: {
    // Official three-block mark in its native 800x800 coordinates, cropped to its bounds.
    viewBox: "165.29 165.29 469.43 469.43",
    d: "M165.29 165.29H517.36V400H400V282.65H165.29ZM165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29ZM517.36 400H634.72V634.72H517.36Z",
  },
};

function glyphFor(cli: string): Glyph | undefined {
  return Object.hasOwn(GLYPHS, cli) ? GLYPHS[cli as AgentCli] : undefined;
}

export interface ProviderIconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  /** Provider (CLI) id. Unknown ids fall back to a generic bot glyph. */
  cli: string;
  size?: number;
  /** Accessible name. Omit for a purely decorative icon (it is then `aria-hidden`). */
  title?: string;
}

export function ProviderIcon({ cli, size = 14, title, className, ...rest }: ProviderIconProps) {
  const glyph = glyphFor(cli);
  const a11y =
    title === undefined
      ? ({ "aria-hidden": true } as const)
      : ({ role: "img", "aria-label": title } as const);
  const classes = className === undefined ? "provider-icon" : `provider-icon ${className}`;
  if (glyph === undefined) {
    return (
      <Bot
        size={size}
        className={classes}
        data-provider-icon="fallback"
        {...a11y}
        {...(rest as object)}
      />
    );
  }
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative (aria-hidden) unless `title` is given, which adds role="img", aria-label and a <title>.
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={glyph.viewBox}
      width={size}
      height={size}
      fill="currentColor"
      fillRule="evenodd"
      focusable="false"
      className={classes}
      data-provider-icon={cli}
      style={{ flex: "none" }}
      {...a11y}
      {...rest}
    >
      {title === undefined ? null : <title>{title}</title>}
      <path d={glyph.d} />
    </svg>
  );
}

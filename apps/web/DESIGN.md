---
name: DevChestra
description: A clear, restrained workspace for orchestrating coding agents.
colors:
  background: "#ffffff"
  background-subtle: "#f8fafc"
  background-muted: "#f1f5f9"
  border: "#e2e8f0"
  border-strong: "#cbd5e1"
  text: "#0f172a"
  text-secondary: "#475569"
  text-muted: "#5b6676"
  accent: "#4f46e5"
  accent-hover: "#4338ca"
  accent-soft: "#eef2ff"
  accent-border: "#c7d2fe"
  success: "#047857"
  success-soft: "#ecfdf5"
  warning: "#b45309"
  warning-soft: "#fffbeb"
  danger: "#b91c1c"
  danger-soft: "#fef2f2"
  info: "#0369a1"
  info-soft: "#f0f9ff"
  dark-background: "#0f1012"
  dark-background-subtle: "#141518"
  dark-background-muted: "#1b1c20"
  dark-border: "#26282d"
  dark-border-strong: "#383b42"
  dark-text: "#eceef1"
  dark-text-secondary: "#a3a8b1"
  dark-text-muted: "#8b919b"
  dark-accent: "#818cf8"
  dark-accent-hover: "#a5b4fc"
  dark-accent-soft: "rgba(129, 140, 248, 0.14)"
  dark-accent-border: "rgba(129, 140, 248, 0.4)"
  dark-success: "#34d399"
  dark-success-soft: "rgba(52, 211, 153, 0.12)"
  dark-warning: "#fbbf24"
  dark-warning-soft: "rgba(251, 191, 36, 0.12)"
  dark-danger: "#f87171"
  dark-danger-soft: "rgba(248, 113, 113, 0.12)"
  dark-info: "#38bdf8"
  dark-info-soft: "rgba(56, 189, 248, 0.12)"
typography:
  headline:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "20px"
    fontWeight: 600
    letterSpacing: "-0.012em"
  title:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "15px"
    fontWeight: 600
    letterSpacing: "-0.012em"
  body:
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "13px"
    lineHeight: 1.45
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
rounded:
  default: "6px"
  large: "8px"
  pill: "10px"
spacing:
  compact: "8px"
  standard: "16px"
components:
  button-default:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    rounded: "{rounded.default}"
    height: "28px"
    padding: "0 10px"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    rounded: "{rounded.default}"
    height: "28px"
    padding: "0 8px"
  card:
    backgroundColor: "{colors.background}"
    rounded: "{rounded.large}"
    padding: "14px"
---

# Design System: DevChestra

## Overview

**Creative North Star: "The Workflow Workbench"**

The interface is clear, restrained, and task-focused. Compact controls, quiet surfaces, and consistent alignment keep attention on workflows and their state. The existing implementation treats color as a functional signal and uses small changes in border, background, and weight to distinguish levels of information.

**Key Characteristics:**
- Compact application density with a persistent workspace shell.
- Cool neutral surfaces with an indigo accent and semantic status colors.
- Bordered panels and precise controls, with shadows reserved for selected surfaces.
- Light and dark themes with shared semantic roles.

## Colors

The palette pairs cool slate neutrals with indigo and distinct semantic colors. The frontmatter records both themes; `src/styles/tokens.css` is the implementation authority for their mapping.

### Primary

- **Indigo accent:** Actions, links, selection, and focus. A pale accent surface and border support selected states.

### Neutral

- **Cool white and slate:** Background layers, borders, primary text, and secondary text. The dark theme replaces these with near-black surfaces and light text.
- **Status colors:** Green, amber, red, and blue pair stronger foregrounds with soft backgrounds for success, warning, danger, and information.

## Typography

The interface uses an Inter-led system sans stack, with a system monospace stack for code and technical values. Body text is 13px at 1.45 line height; headings step from 20px to 15px and 13px with weight 600. Monospace content commonly uses 12px. The implementation does not load an external font.

## Layout

The application shell uses a 244px sidebar and a flexible main area, with a 48px top bar. Standard pages have a 1080px maximum width and 28px 32px 72px padding. Eight- and sixteen-pixel gaps recur in rows and stacks. At 900px the sidebar and inspector narrow; at 720px the sidebar is hidden. Individual editor and run layouts have additional responsive rules.

## Elevation & Depth

Borders and subtle background shifts define most surfaces. Light-theme controls and canvas elements use a small shadow (`0 1px 2px rgba(15, 23, 42, 0.06)`); floating surfaces use a larger shadow (`0 4px 14px rgba(15, 23, 42, 0.1)`). In dark mode the small shadow is removed and the larger shadow becomes `0 8px 24px rgba(0, 0, 0, 0.45)`.

## Shapes

Controls use gently rounded 6px corners; cards use 8px. Status pills use 10px rounding, while borders are typically 1px. The workflow canvas uses bordered nodes and a visible accent treatment for selection.

## Components

### Buttons

Default buttons are 28px high with 10px horizontal padding, a border, and a small shadow. Ghost buttons remove the resting border and shadow. Hover uses the muted background; disabled buttons reduce opacity. Keyboard focus uses the global accent outline.

### Inputs and fields

Fields are 28px high with 8px horizontal padding, a border, and a 6px radius. Focus changes the border to accent and adds a 3px soft accent ring.

### Cards and tables

Cards use an 8px radius and a 1px border; headers and bodies have compact padding. Tables use muted 12px headings, horizontal dividers, and a subtle background on interactive-row hover.

### Navigation and tabs

The sidebar uses compact rows with icons and muted text. Active navigation adds a soft accent background, accent text, and a 2px inset edge. Tabs use an accent bottom border for the active item.

### Chips and status pills

Chips are bordered, 22px-high controls; selected chips use the accent border and soft background. Status pills are 20px high with semantic foreground and background pairs.

## Do's and Don'ts

### Do:
- **Do** use semantic theme variables so both light and dark modes retain their intended roles.
- **Do** make focus, selection, status, and disabled states visible.
- **Do** respect reduced-motion preferences, as the existing styles do.

### Don't:
- **Don't** rely on color alone to communicate status or selection.
- **Don't** replace compact, bordered application surfaces with decorative elevation without a specific reason.

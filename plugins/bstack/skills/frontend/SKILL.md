---
name: frontend
description: Rules for UI code in web apps - container-query-first layout, ACSS-named design tokens, component boundaries, scripts and basic accessibility. Load before writing or changing HTML, CSS, templates or client-side JS.
---

# Frontend

**Goal:** UI that works wherever it is placed, and each change moves the app towards one system.

Right forms: [example.html](example.html). Starter tokens and utilities: [tokens.css](tokens.css).

## Responsive order

1. Intrinsic CSS first: `repeat(auto-fit, minmax(min(100%, 20rem), 1fr))`, `flex-wrap`, `max-inline-size`, `min()`, `max()`.
2. Then a container query. The component makes its own parent the container with has-me, exactly `.card { :has(> &) { container-type: inline-size; } }`. Never `:has(&)`: without `>` it turns every ancestor into a container.
3. `@media` only for the viewport shell: page frame, header, modal, drawer, fixed elements.

- A grid item that uses container queries gets its own cell (`li` or `div`), so the cell is measured, not the grid.
- Breakpoints come from the content (where it breaks), never preset device widths. Range syntax and `rem`: `@container (inline-size >= 36rem)`.
- Logical properties: `inline-size`, `margin-inline`, `padding-block`.

## Tokens

- Names follow Automatic.css 4: `--primary`, `--accent`, `--base`, `--neutral` with `-ultra-light` to `-ultra-dark`, `--text-dark`, `--bg-light`, `--text-xs` to `--text-xxl`, `--h1` to `--h6`, `--space-xs` to `--space-xxl`, `--content-gap`, `--container-gap`, `--grid-gap`, `--radius`, `--border`, `--box-shadow-1`, `--gutter`, `--focus-color`. No ACSS install, no build step.
- Values belong to the repo, in its own `:root`. A repo adopting tokens copies tokens.css once and owns it from then on.
- Names keep their light-scheme role; the dark scheme swaps the values, so `color: var(--text-dark)` works in both.
- Component rules take colour, type, space, radius, border and shadow from tokens. No hex, no raw px. Units are `rem`; no `to-rem()`.
- `clamp()` only in token definitions. Component rules use a token or `calc()` of tokens.
- Related values derive from one local property. Wrong: `padding: 1rem; gap: 0.5rem`. Right: `--_pad: var(--space-m); padding: var(--_pad); gap: calc(var(--_pad) / 2)`.

## Components

- One root element. BEM classes whose block is the component name: `.card`, `.card__title`.
- The parent owns layout: the root sets no outer margin, width, column count or grid placement.
- Never style another block's elements from outside. Wrong: `.sidebar .card__title`. Right: a variant of the card.
- Variants are `data-*` on the root (`.card[data-tone="accent"]`) or a container query.
- Extract a component on its second use. Extend a near-duplicate with optional parts whose defaults keep the old behaviour, instead of adding a copy.
- Utility classes are the fixed list in tokens.css: `.visually-hidden`, `.btn` with `data-variant`. No ad-hoc helpers such as `.mt-2` or `.flex-center`.

## Scripts

- Idempotent: initialising twice binds once (mark the root, as `data-ready` in the example).
- Hook on the component's own classes or `data-*`, never on utility or layout classes.
- No inline styles for what CSS can express. Toggle `hidden`, `aria-*` or `data-*` and let CSS respond.

## Accessibility basics

Web apps, not public sites, so basics only:
- Semantic elements: `main`, `nav`, `header`, `ul`, `table` for tabular data.
- `button` for actions, `a[href]` for navigation. No `href="#"`, no clickable `div`.
- Every input, select and textarea has a label: `label[for]`, a wrapping `label`, or `aria-label`.
- Visible focus: tokens.css styles `:focus-visible`; never remove an outline without a replacement.

## Existing repos

- No forced migration. A PR that touches a component's CSS moves that component to tokens and container queries, and resolves name collisions in the same PR. Example: a repo's `--text` colour collides with the `--text-*` size scale; the colour becomes `--text-dark`.
- Harmonisation keeps function unchanged (routes, data, actions); the look may change. The evidence is before and after screenshots at 375 and 1280 px, not a zero pixel diff.

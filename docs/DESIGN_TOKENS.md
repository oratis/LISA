# Web shell design tokens

> Source of truth: [`src/web/assets/client/main.css`](../src/web/assets/client/main.css).
> This document describes the tokens; the CSS defines them. When they disagree, the CSS wins —
> and the contrast table below is enforced by [`src/web/lisa-css.test.ts`](../src/web/lisa-css.test.ts),
> so a token change that breaks AA fails the test suite.

The shell ships two complete themes. **Nebula** (dark, default) is the original glass-morphism
console; **Calm** (light) is a flat professional variant. They are one token set with two value
sets: every rule in the stylesheet reads `var(--…)`, and the theme swap is a single
`<body data-theme="calm">` attribute persisted in `localStorage` under `lisa-theme`.

## Colour

### Brand and semantics

| Token | Nebula | Calm | Used for |
| --- | --- | --- | --- |
| `--accent` | `#6ad4ff` | `#4f5bd5` | Primary action, active nav, focus ring, links |
| `--accent-soft` | `rgba(106,212,255,.13)` | `rgba(79,91,213,.09)` | Active tile / chip background |
| `--accent-glow` | `rgba(106,212,255,.27)` | `rgba(79,91,213,.25)` | Active border, halo |
| `--proactive` | `#3ddc97` | `#1f9d6b` | Autonomy is live (heartbeat, watching) |
| `--warm` | `#ffd066` | `#d97706` | Attention, pending approval |
| `--dream` | `#b487ff` | `#7c5cd6` | Rêve / idle reflection |
| `--claude` | `#ff8c42` | `#e2681c` | Claude Code sessions |
| `--codex` | `#7ea6ff` | `#3d6fd8` | Codex sessions |
| `--err-color` | `#ff5577` | `#dc3545` | Errors, failed tools |

Each accent has a `-soft` (fill) and some a `-glow` (border) variant. Never hard-code an accent
literal in a rule — the Calm theme only works because every consumer reads the token.

### Surfaces and text

| Token | Nebula | Calm | Role |
| --- | --- | --- | --- |
| `--bg-deep` | `#07091a` | `#f6f7f9` | Page ground |
| `--bg-1` … `--bg-3` | `#0b1024` … `#1a1f4a` | `#f6f7f9` … `#e7eaf0` | Raised surfaces |
| `--bg-card` | `rgba(20,26,64,.65)` | `#ffffff` | Panels, cards |
| `--bg-card-strong` | `rgba(20,26,64,.88)` | `#ffffff` | Composer, modals |
| `--border-new` | `rgba(255,255,255,.07)` | `#e4e7ec` | Default border |
| `--border-strong` | `rgba(255,255,255,.14)` | `#d5d9e2` | Emphasised border |
| `--hairline` | `rgba(255,255,255,.06)` | `#edf0f4` | Section dividers |
| `--fg` | `#e8eaff` | `#1b2430` | Body text |
| `--fg-2` | `#aeb5d3` | `#4d5666` | Secondary text |
| `--fg-3` | `#8189ae` | `#5f6878` | Tertiary text, metadata |
| `--fg-faint` | `#444a6e` | `#c2c7d1` | Decorative only — never text |

`--bg`, `--panel`, `--border`, `--text`, `--you`, `--lisa`, `--tool`, `--error` are the older
pixel-art-era aliases kept for the Room and a few legacy rules.

### Contrast (WCAG AA, measured)

Every token that carries text clears 4.5:1 against the surfaces it is used on. Measured ratios:

| Theme | Token | Surface | Ratio |
| --- | --- | --- | --- |
| Nebula | `--fg` | `--bg-deep` | 16.60:1 |
| Nebula | `--fg-2` | `--bg-deep` | 9.74:1 |
| Nebula | `--fg-3` | `--bg-deep` | 5.76:1 |
| Nebula | `--accent` | `--bg-deep` | 11.73:1 |
| Calm | `--fg` | `--bg-card` | 15.65:1 |
| Calm | `--fg-2` | `--bg-card` | 7.40:1 |
| Calm | `--fg-3` | `--bg-card` | 5.62:1 |
| Calm | `--fg-3` | `--bg-deep` | 5.24:1 |
| Calm | `--accent` | `--bg-card` | 5.54:1 |

`--fg-faint` is deliberately below AA and is only allowed on non-text decoration (separators,
disabled glyphs). The test asserts the ratios above; it does not assert `--fg-faint`.

## Type

One family (system UI stack) and one mono stack (`ui-monospace, "SF Mono", Menlo`). The scale is
deliberately short:

| Size | Role |
| --- | --- |
| 11.5px | The floor. Metadata, labels, tree rows, secondary lines. Nothing smaller carries text. |
| 12 – 13px | Body text, chat messages, form controls |
| 14 – 16px | Section headings, the composer on mobile (16px prevents iOS Safari auto-zoom) |
| 18 – 22px | Identity name, modal titles |

8px survives only on three non-text decorations. Before this pass the shell used 10px and 10.5px
for metadata; those were raised to 11.5px, which is why it is by far the most common size.

## Space, radius, motion

- **Grid**: 8px. Padding and gaps are multiples of 4 with 6/10/14 as the common in-between steps.
- **Radius**: 8px is the default; 6px for small chips, 9–12px for cards and inputs, 999px for pills.
- **Motion**: 0.12s for colour/background transitions, 0.18–0.24s for layout and overlays. All
  non-essential animation sits inside `@media (prefers-reduced-motion: no-preference)`, and a
  `prefers-reduced-motion: reduce` block neutralises the rest.

## Focus

```css
--focus-ring: 2px solid var(--accent);
--focus-ring-offset: 2px;

:focus-visible {
  outline: var(--focus-ring);
  outline-offset: var(--focus-ring-offset);
}
```

`:focus-visible`, not `:focus`, so a mouse click never paints a ring. Text inputs keep their own
accent-border-plus-halo treatment through more specific `:focus` rules. Nothing in the shell may
set `outline: none` without providing a replacement indicator.

## Layout and breakpoints

The shell is a three-column CSS grid: 300px session tree · fluid main · 320px right rail.

| Width | Layout |
| --- | --- |
| > 1180px | Three columns. The rail collapses to two columns on demand (`body.rb-collapsed`, default). |
| ≤ 1180px | Two columns; the right rail is hidden. |
| ≤ 720px | One column, stacked: title bar · sidebar (capped at 38vh, scrolls) · main. The rail stays hidden, the function bar drops its five quick-panel buttons, and the composer switches to a 16px font and a short placeholder. |

`body.rb-collapsed` is scoped inside `@media (min-width: 721px)`: its specificity is higher than a
bare `.frame` rule, so at phone widths an unscoped collapse rule would win over the stacked layout
and leave the main column a few dozen pixels wide.

`body.force-compact` reproduces the stacked layout at any width so Lisa can be docked as a skinny
side panel.

## Touch targets

Interactive controls are at least 36px on the desktop layout. At ≤720px every small control
(function-bar buttons, tree controls, chip dismissers) gets a transparent `::after` inset that
expands its hit area to 44px without changing what is drawn — WCAG 2.5.8 without a visual redesign.

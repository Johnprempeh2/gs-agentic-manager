# GS Agentic Manager Design Principles

**Status:** v0.3 — anchor document for design-language simplification. Governs structure, not brand. Brand values (color, type, iconography) are intentionally unspecified: they are being redesigned and will land as token values only. Nothing in `ui/` may hardcode them. Spacing/radius scales are likewise TBD pending the token audit (see Principle 3).

Changes from v0.2: token layer location corrected to the repo's real source (`ui/src/index.css`); existing token tiers inventoried; snapshot-coverage scope bounded for Run 1; the issue→task copy rename moved out of the zero-visual-change run.

## What this document is for

Agents and humans modifying `ui/` treat this file as the source of truth for design decisions. Storybook is the verification surface — it documents the system; it does not define it. If a change conflicts with this document, change this document first (with review) or change the code.

## Product stance

GS Agentic Manager is an operational control plane: org charts, tasks, heartbeat runs, budgets, approvals, audit logs. The user is an operator scanning state and making decisions. Every screen should answer, in order: *what is happening, does it need me, what do I do about it.* Density in service of scanning beats whitespace in service of aesthetics — but density comes from information, never from chrome.

## The token layer (where visual values live)

The single token source is **`ui/src/index.css`** (Tailwind v4; there is no tailwind config file — tokens are CSS custom properties consumed via `@theme`). Do NOT create a parallel token source such as `ui/src/tokens/` — that would produce two sources of truth. If index.css grows unwieldy, extracted values may live in a `tokens.css` **imported by index.css** so the pipeline still has one root.

Tailwind v4 gotcha: `@theme inline` bakes literal values at build time. Any token that must be runtime-tunable (theme editor, dark mode overrides) must be defined in a NON-inline block.

Existing tiers already in index.css (~80+ tokens) — extraction maps to these on **exact value match** before minting anything new:

1. **Semantic tier** — shadcn core set: `--background`, `--foreground`, `--card`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, `--sidebar-*`, `--chart-1..5` (OKLCH, light/dark overrides).
2. **Brand tier** — agent gradients `--agent-1a/1b..10a/10b` (fixed hex) and status hues `--status-task-*` / `--status-agent-*` (WCAG-tuned; see inline comments).
3. **Domain tier** — match-chip tokens `--chip-match-*`, annotation highlights `--paperclip-doc-annotation-highlight-*`, plus motion/typography tokens.

## Principles

1. **One way to say each thing.** One component per job. One Button, one Card, one Badge, one Table, one EmptyState. Variants are props, not new components. Before creating a component, prove no existing one covers the job.
2. **Tokens are the only source of visual values.** All color, spacing, radius, type size/weight, shadow, and motion values come from the token layer. No hex, no raw px, no ad-hoc Tailwind arbitrary values (`p-[13px]`) in components. If a needed value doesn't exist, add a token — don't inline it. Tailwind palette classes (`bg-red-500`, `text-zinc-400`, etc.) ARE hardcoded values in spirit: they name a literal color, not a semantic role. They are in-scope debt scheduled for a dedicated future run (Run 4, cluster-by-cluster mapping to semantic tokens per doc/design/DECISION-SHEET.md B2) and are ratcheted, not banned: `scripts/check-named-colors.mjs` (run by `pnpm check:token-gates`) fails if any file has more of them than its saved count in `scripts/check-named-colors.baseline.json`; after removing some, run `node scripts/check-named-colors.mjs --update` to lower the saved count. Exception (doc/design/DECISION-SHEET.md B1 user ruling): first-party intentional one-off decoration on demo/UX-lab surfaces stays inline and allowlisted rather than minted as singleton tokens.
3. **Spacing routes through tokens; the scale comes later.** During simplification, extract every spacing and radius value verbatim into tokens — do not normalize, round, or invent a scale. The final scale is a design decision made by a human after reviewing the token audit. Structural rules apply now: vertical rhythm within a container uses one gap value, not per-element margins, and siblings never carry both margin and gap.
4. **Hierarchy through structure, not decoration.** Prefer position, size, and weight over borders, backgrounds, and dividers. Every border, divider, and background fill must justify itself; when in doubt, remove it. A screen should survive the removal of one visual layer.
5. **Status is systematic.** States like running / paused / blocked / awaiting-approval / over-budget map to a single semantic status token set used identically everywhere (badge, row, chart, log). An operator learns the vocabulary once.
6. **Machine values look machine-made.** IDs, costs, token counts, timestamps, and log output use the monospace token and consistent formatting helpers. Never format these ad hoc per screen.
7. **Words are part of the system.** One name per concept across the entire UI — the canonical term is *task* (never *issue* or *ticket* in copy, labels, or empty states). Buttons name the action ("Approve hire," not "Submit"). Errors say what happened and what to do. Empty states say what to do first. **Note:** enforcing the task rename is a visible change and is explicitly OUT of the zero-visual-change extraction run; it happens in its own follow-up run.
8. **Agent-modifiable by design.** The system must be changeable via instructions: single token source, lint rules that enforce it, and this document kept current. A correct change should be expressible as "edit tokens + run checks," not "visit 40 files."

## Form and wizard footers

Keep **Save & exit** (or Cancel/Back) and the primary Continue/Connect/Finish
action in one shared footer row, vertically centered. Put the subdued secondary
action on the left and the primary action on the right. A step owns its whole
footer: do not render Save & exit in a separate parent block below it. Check this
alignment in every step and conditional state, not just the first screen.

## Contextual feedback

Do not show a toast for task or run state already visible on the current screen.
This includes descendant runs represented by the open subtree. Show local action
results in place; keep failures actionable inline. Notifications for other work
remain useful. Repeated delivery of the same run outcome must refresh cached state
without repeating its toast, including after reconnecting. A terminal outcome
delivered more than five minutes after the run finished is historical and should
refresh state silently. Expected cancellation is neutral gray, not an error. The composer's Stop action stops the current response and leaves the composer available for a new message. Pause work is a separate explicit task or subtree action. A paused task replaces the composer with an amber takeover. It says “Task is
paused.” and “Resume this task to send a message.” with a “Resume task” action.
Subtrees use “Subtree is paused.” and “Resume subtree.” The takeover cannot be
dismissed, retains drafts, and hides message inputs until the pause is released.

## Enforcement (what "compliant" means for the extraction run)

- **Zero visual change is proven, not promised:** Storybook visual snapshots are baselined before any refactor, and all snapshots match baseline after it. A change that alters rendered output must be intentional and human-approved.
- **Baseline scope for Run 1:** the shared primitives in `ui/src/components/ui/` (each gets a story if missing — there are only ~24) plus the ~46 existing stories under `ui/storybook/stories/`. Do NOT attempt a story for every feature component (~277) in this run; full coverage is a later effort.
- Mechanical rewrites (value extraction, renames) are done via committed codemod scripts in `scripts/`, not hand-edits — reviewable once, repeatable forever.
- Token layer is the single source (`ui/src/index.css`, per above) consumed via CSS variables / Tailwind theme — never values copied into components.
- Lint/grep gates pass: zero hardcoded hex values, zero arbitrary spacing values, zero raw font-size declarations in `ui/src/components/**` and `ui/src/pages/**` outside the token layer and a documented allowlist (third-party overrides, intentional opt-outs commented inline).
- `pnpm build`, `pnpm typecheck`, and `pnpm build-storybook` pass.
- AGENTS.md links here and states the token-only rule.

Aspirational (NOT gating this run): no duplicate components; every component has exactly one story covering its variants; all UI copy says "task".

## Out of scope (do not do during simplification)

No visual redesign, no new colors or typefaces, no layout restructuring, no new dependencies beyond snapshot tooling, no component consolidation/merges (audit + recommend only), no copy renames, no changes to server code or app logic. Simplification means fewer parts, same product.

## Prior art (read before auditing)

See `doc/design/PRIOR-ART.md` — a previous audit pass (PAP-280/283/284, on the `PAP-282-playground` branch, NOT on master) found that of ~220 hardcoded drift sites, only 6 were exact-value-mappable to existing tokens; expect the verbatim extraction to mint many new tokens that the human scale-collapse step later merges. It also drafted usage rules (radius tiers, CTA tiers, named type styles) that are good candidates for the post-audit scale decision.

How-to guide for day-to-day UI changes: see `doc/design/CHANGING-THE-UI.md`.

## Motion tokens (Task Chat Redesign)

The redesigned task thread (flag `enableTaskChatRedesign`) is the first surface to
tokenize motion. Principles — reasoning only; values live in `ui/src/index.css`:

- **One home, and it is `:root`, not `@theme inline`.** `@theme inline` bakes literals
  at build time, so a value placed there cannot be moved at runtime. The dev tweak panel
  tunes motion by writing CSS custom properties live, so every motion token must resolve
  at runtime — hence `:root`.
- **Two tiers.** Primitives (`--motion-duration-*`, `--motion-ease-*`) express the app's
  baseline motion feel; state/component-scoped tokens (`--motion-<state>-*`) reference the
  primitives so the whole thread retunes from a few knobs. Scoped tokens exist so the
  tweak panel can group controls by the state they affect.
- **Reuse the house curves.** New easing defaults point at the two curves already used
  across the app rather than inventing a third feel.
- **No hardcoded timing in components.** Durations, easings, delays, and staggers used by
  the redesigned thread must reference these tokens; a check script rejects raw `ms` /
  `cubic-bezier` values outside `ui/src/index.css`. This discipline is what makes the
  tweak panel structurally possible.
- **Values are placeholders.** The committed numbers are sensible starting points, tuned
  live by a human and pasted back from the tweak panel's export — never treated as final
  during the baseline build.
- **Reduced motion is honored at the token layer.** A `prefers-reduced-motion: reduce`
  block collapses the duration/stagger tokens to zero, cascading to every scoped token,
  in addition to each animation's own component-level guard.

## Daylight (light mode) surfaces

Light mode is a warm stone canvas (`--background`, `#e9ede3`) under white
surfaces (`--card`), beside a charcoal navigation rail. Depth comes from that
step plus layered shadows, not extra borders. Light mode is never plain white:
the brand colour comes from the charcoal rail, the lime and teal light in
`--gs-atmosphere` and the emerald `--primary`.

- **Charcoal rail.** The navigation rail is night-side in both themes.
  `Layout.tsx` puts `gs-rail dark` on the rail wrappers (desktop
  `SidebarShell` and the phone drawer), so everything inside reads the dark
  tokens and `dark:` utilities. In light mode `:root:not(.dark) .gs-rail`
  (`index.css`) sets the rail to brand charcoal `#252525` with an 8% lime
  active row. Do not add light-only colours inside the rail; style rail
  content for dark mode and it is right in both. Popovers and menus opened
  from the rail portal out and follow the page theme.

- **Surfaces.** Use `bg-card` (or the `Card` component, `gs-glass-card`) for
  anything that holds content. A bare `rounded-* border border-border` box with
  no `bg-*` class takes the card fill in light mode automatically
  (`greatstone-glass.css`); give it an explicit `bg-*` to opt out. Never assume
  `--card` and `--background` are the same colour.
- **Brand washes.** `--accent` (hover, selected rows, the active item in a
  settings nav, selected segmented controls) is a soft lime wash in light
  mode, so interaction carries the brand colour. Text on it stays ink.
- **Card rim.** Glass cards carry `--glass-rim`: in light mode a lime to teal
  brand edge (lime top left, teal bottom right). It is decoration only.
- **Page bar.** `.gs-page-bar` (the title bar on every page) carries
  `--gs-page-bar-wash`, a teal to lime band in light mode and `none` at night.
- **Heading icons.** An icon that is the first child of an `h1` to `h4` with
  `text-muted-foreground` renders brand emerald in light mode.
- **Secondary navs.** `[data-secondary-sidebar]` panels sit on a teal-tinted
  stone in light mode, and their active row is the lime wash.
- **Small brand touches.** In light mode the selected pill tab is a lime wash
  (`--gs-tab-pill-bg`), an on switch glows lime, loading skeletons are teal
  tinted and scrollbars are emerald tinted.
- **Eyebrows.** Uppercase section labels (`h2` to `h4` with `uppercase
  text-muted-foreground`) render in `--eyebrow-foreground` (brand emerald)
  in light mode through one rule in `index.css`; keep writing them as
  `text-muted-foreground` and they stay grey at night.
- **Fields.** Inputs, textareas and select triggers use `bg-field`: white in
  light mode, transparent on the void (where `dark:bg-input/30` applies).
- **Lime.** `bg-highlight text-highlight-foreground` is the brand lime under ink
  in both themes. Lime is never text or a thin line on a light surface (1.15:1).
- **Destructive.** A deep brick (`--destructive`) in light mode, so a Reject
  button can sit beside Approve without shouting.
- **Status colour.** Use the status tokens (`bg-status-success-soft
  text-status-success-foreground`, and the warning, danger and info sets) for
  chips, eyebrows and notes. Named Tailwind palette classes are capped by
  `scripts/check-named-colors.baseline.json`; the foreground tokens are tuned
  to reach WCAG AA (4.5:1) on both the card and the soft fill.
- **Contrast.** Body text, chips and counts must reach 4.5:1 (3:1 for large
  text) on the surface they sit on, in both themes. Check new colours before
  adding them; "close enough" in daylight is often 3:1.
- **Scrim.** Dialogs dim the page with `--glass-scrim` and a light blur, not a
  black wash.
- **Focus.** Keyboard focus is the solid `--ring` (dark ink by day), never a
  half-strength ring: at 50% it falls under 3:1 on the stone canvas. Controls
  without their own focus style get a 2px ring from one base rule in
  `index.css`. A rule that flattens a button's shadow must leave
  `:focus-visible` alone, because the ring is a box-shadow too.
- **Paused or quiet rows.** Never fade a row with opacity to say it is paused
  or inactive; use a text token and the status chip.

## Night (dark mode) surfaces

Dark mode keeps the near-black void (`--background`) with cards one step
above it (`--card`), and popovers one step above that (`--popover`). The same
rule as daylight applies: a card must read as raised, so never set `--card`
equal to `--background`.

- **Hover and focus.** Hover uses `--accent` (a faint lime tint). Focus is the
  solid lime `--ring`, never removed without a visible replacement.
- **Text on fills.** Text and fallback initials on a coloured fill inherit the
  fill's foreground (`text-current`), never `text-muted-foreground`.
- **Markdown.** Rendered markdown pins headings and table headers to
  `--foreground`, so prose defaults never leave near-black text on the void.

## Print

Browser print and "Save as PDF" always come out in daylight colours, whatever
theme is on screen. `ThemeContext` drops the `dark` class on `beforeprint`
and restores it on `afterprint`, so every token prints with its light value.
The `@media print` block in `ui/src/index.css` backs that up for the core
surface and text tokens, drops shadows and glass,
and hides secondary sidebars; `Layout.tsx` hides the rest of the app chrome
with `print:` utilities so only the page prints, as one flowing column.

- **Actions.** Mark buttons and controls that mean nothing on paper
  `print:hidden` (see the This week report header).
- **Blocks.** Give each card or section `print:break-inside-avoid` so a page
  break never splits it.
- **No new colours.** Print uses the same tokens; never add print-only hex in
  a component.

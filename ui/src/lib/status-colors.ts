/**
 * Canonical status & priority color definitions.
 *
 * Every component that renders a status indicator (StatusIcon, StatusBadge,
 * agent status dots, etc.) should import from here so colors stay consistent.
 * Recipes use the semantic status tokens (`text-status-warning`,
 * `bg-status-danger-soft`, ...) from `index.css`, never raw palette classes.
 */

// ---------------------------------------------------------------------------
// Issue status colors
// ---------------------------------------------------------------------------

// PAP-75 brand mapping ("blue = liveness"): todo → amber (queued), in_progress
// → blue (live). See `issueStatusColor` below for the canonical chip palette.
//
// The brand mapping is the default status palette. Chat-specific gating stays
// isolated to the Conference Room route/nav/API and does not control task
// status presentation.

/** StatusIcon circle: text + border classes */
export const issueStatusIcon: Record<string, string> = {
  backlog: "text-muted-foreground border-muted-foreground",
  todo: "text-status-warning border-status-warning",
  in_progress: "text-status-running border-status-running",
  in_review: "text-status-review border-status-review",
  done: "text-status-success border-status-success",
  cancelled: "text-status-neutral border-status-neutral",
  blocked: "text-status-danger border-status-danger",
};

export const issueStatusIconDefault = "text-muted-foreground border-muted-foreground";

/** Text-only color for issue statuses (dropdowns, labels) */
export const issueStatusText: Record<string, string> = {
  backlog: "text-muted-foreground",
  todo: "text-status-warning",
  in_progress: "text-status-running",
  in_review: "text-status-review",
  done: "text-status-success",
  cancelled: "text-status-neutral",
  blocked: "text-status-danger",
};

export const issueStatusTextDefault = "text-muted-foreground";

// ---------------------------------------------------------------------------
// Brand `.task-chip` status palette (PAP-75 / status-reference.html)
//
// Colour-named, 1px border, light + dark — values straight from paperclip.ing
// `brand.css`. Shared by the agents section (PAP-80) and the All Projects page
// (PAP-91); PAP-99 brings it to issue/task status chips, adding `violet` for
// `in_review`.
// ---------------------------------------------------------------------------

export type BrandChipColor = "gray" | "blue" | "amber" | "green" | "violet" | "red";

export const brandChipBadge: Record<BrandChipColor, string> = {
  gray: "bg-[#F5F3F0] text-[#52585D] border-[#A8AEB2] dark:bg-[#6e696024] dark:text-[#9A958A] dark:border-[#9e958a73]",
  blue: "bg-[#DBEAFE] text-[#1D4ED8] border-[#2563EB] dark:bg-[#2563eb2e] dark:text-[#2563EB] dark:border-[#2563eb73]",
  amber: "bg-[#FEF3C7] text-[#B45309] border-[#F59E0B] dark:bg-[#f59e0b24] dark:text-[#F59E0B] dark:border-[#f59e0b73]",
  green: "bg-[#DCFCE7] text-[#188A3C] border-[#22C55E] dark:bg-[#22c55e1f] dark:text-[#22C55E] dark:border-[#22c55e73]",
  violet: "bg-[#EDE9FE] text-[#5B21B6] border-[#7C3AED] dark:bg-[#7c3aed2e] dark:text-[#7C3AED] dark:border-[#7c3aed73]",
  red: "bg-[#FEE2E2] text-[#991B1B] border-[#DC2626] dark:bg-[#dc26262e] dark:text-[#DC2626] dark:border-[#dc262673]",
};

// ---------------------------------------------------------------------------
// Badge colors — used by StatusBadge for all entity types
// ---------------------------------------------------------------------------

export const statusBadge: Record<string, string> = {
  // Agent statuses
  // Gallery feedback r3: agent chips route through the brand chip families
  // (bordered .task-chip recipes) instead of ad-hoc tints. NOTE: `active` has
  // no canonical agent status — user-ruled mapping to the brand GREEN family;
  // `idle` is the gray family (was a yellow/amber tint); `error` rides the
  // shared run-status red entry below.
  active: `border ${brandChipBadge.green}`,
  running: `border ${brandChipBadge.blue}`, // r1 made this blue; r3 routes through brandChipBadge.blue.
  scheduled_retry: "bg-status-info-soft text-status-info-foreground",
  paused: `border ${brandChipBadge.amber}`,
  idle: `border ${brandChipBadge.gray}`,
  archived: "bg-muted text-muted-foreground",

  // Goal statuses
  planned: "bg-muted text-muted-foreground",
  achieved: "bg-status-success-soft text-status-success-foreground",
  completed: "bg-status-success-soft text-status-success-foreground",

  // Run statuses
  failed: "bg-status-danger-soft text-status-danger-foreground",
  timed_out: "bg-status-alert-soft text-status-alert-foreground",
  succeeded: "bg-status-success-soft text-status-success-foreground",
  ok: "bg-status-success-soft text-status-success-foreground",
  warning: "bg-status-warning-soft text-status-warning-foreground",
  error: "bg-status-danger-soft text-status-danger-foreground",
  info: "bg-status-info-soft text-status-info-foreground",
  terminated: "bg-status-danger-soft text-status-danger-foreground",
  pending: "bg-status-pending-soft text-status-pending-foreground",
  // Skill Studio test-run "queued" aligns with pending (yellow). PAP-12962 D6.
  queued: "bg-status-pending-soft text-status-pending-foreground",

  // Approval statuses
  pending_approval: "bg-status-warning-soft text-status-warning-foreground",
  revision_requested: "bg-status-warning-soft text-status-warning-foreground",
  approved: "bg-status-success-soft text-status-success-foreground",
  rejected: "bg-status-danger-soft text-status-danger-foreground",

  // Case statuses (PAP-12968 E3) — `draft` is the neutral pre-work state,
  // rendered as a muted gray alias of `backlog`/`planned`. The other case
  // statuses (in_progress/in_review/approved/done/cancelled) already map above.
  draft: "bg-muted text-muted-foreground",

  // Issue statuses — consistent hues with issueStatusIcon above (PAP-75 brand
  // mapping: todo → amber, in_progress → blue "liveness").
  backlog: "bg-muted text-muted-foreground",
  todo: "bg-status-warning-soft text-status-warning-foreground",
  in_progress: "bg-status-running-soft text-status-running-foreground",
  in_review: "bg-status-review-soft text-status-review-foreground",
  blocked: "bg-status-danger-soft text-status-danger-foreground",
  done: "bg-status-success-soft text-status-success-foreground",
  cancelled: "bg-muted text-muted-foreground",

  // Tool access — policy decisions, catalog, and runtime health (Tools & Access, PAP-10389)
  allowed: "bg-status-success-soft text-status-success-foreground",
  denied: "bg-status-danger-soft text-status-danger-foreground",
  block: "bg-status-danger-soft text-status-danger-foreground",
  "require-approval": "bg-status-warning-soft text-status-warning-foreground",
  redacted: "bg-status-review-soft text-status-review-foreground",
  "rate-limit": "bg-status-alert-soft text-status-alert-foreground",
  deferred: "bg-status-info-soft text-status-info-foreground",
  hidden: "bg-muted text-muted-foreground",
  quarantined: "bg-status-danger-soft text-status-danger-foreground",
  "runtime-error": "bg-status-danger-soft text-status-danger-foreground",
  healthy: "bg-status-success-soft text-status-success-foreground",
  degraded: "bg-status-warning-soft text-status-warning-foreground",
  unchecked: "bg-muted text-muted-foreground",

  // Memory record review states (GRE-865, phase 2 values). `approved` maps above.
  unreviewed: "bg-status-pending-soft text-status-pending-foreground",
  disputed: "bg-status-alert-soft text-status-alert-foreground",
  superseded: "bg-muted text-muted-foreground",
  deleted: "bg-muted text-muted-foreground",
};

export const statusBadgeDefault = "bg-muted text-muted-foreground";

// ---------------------------------------------------------------------------
// Agent status — brand state system (PAP-75)
// ---------------------------------------------------------------------------

export type AgentBadgeColor = "gray" | "blue" | "amber" | "red";

/** Agent status → brand colour name. `active` aliases idle (never assigned). */
export const agentStatusColor: Record<string, AgentBadgeColor> = {
  idle: "gray",
  active: "gray",
  running: "blue",
  paused: "amber",
  error: "red",
};

export const agentStatusColorDefault: AgentBadgeColor = "gray";

// Brand `.task-chip` styles per colour name live in `brandChipBadge` below —
// `AgentBadgeColor` is a subset of `BrandChipColor`, so agent badges index
// straight into it. (A byte-identical `agentStatusBadge` duplicate map was
// collapsed into `brandChipBadge` in the Run 2 review; DECISION-SHEET.md A1.)

/** Heartbeat-capsule fill (solid) per colour name. gray darkens in dark mode. */
export const agentStatusCapsule: Record<AgentBadgeColor, string> = {
  gray: "bg-[#A8AEB2] dark:bg-[#6E6960]",
  blue: "bg-[#2563EB]",
  amber: "bg-[#F59E0B]",
  red: "bg-[#DC2626]",
};

/** Per-status capsule motion (running pulses, error blinks). Honors reduced-motion. */
export const agentStatusMotion: Record<string, string> = {
  running: "hb-pulse",
  error: "hb-blink",
};


/**
 * Brand blue TEXT pair (the text hues of `brandChipBadge.blue`) for non-chip
 * "Running" labels — Gallery feedback round 1: running-state copy uses the
 * canonical status blue, not cyan/teal. Kept here so components stay free of
 * hex literals (token-gate scope).
 */
export const runningLabelText = "text-[#1D4ED8] dark:text-[#2563EB]";

/**
 * Liveness-blue badge recipe — the shared "Live" / "Running" pill treatment
 * (translucent blue fill + border + blue text). One source of truth so every
 * live/running indicator reads as the same blue.
 */
export const liveBlueBadge = "bg-status-running/10 border-status-running/30 text-status-running";

/**
 * Issue/task status → brand colour name (PAP-75). `in_progress` is blue
 * (liveness), `todo` amber (queued), `in_review` violet (awaiting review),
 * `done` green, `blocked` red, `backlog`/`cancelled` gray (inert).
 */

// ---------------------------------------------------------------------------
// Inline banner tones (built-in agents provenance / paused notices)
//
// Softer, full-width banner surface derived from the same brand hue anchors as
// `brandChipBadge`. `info` carries provenance/informational context, `warning`
// carries paused/attention context, and `danger` carries failed actions. Consumed by
// `<InlineBanner>` so feature banners stay token-backed instead of hand-rolling
// per-instance `bg-yellow-*`/`bg-blue-*` recipes.
// ---------------------------------------------------------------------------

export type BannerTone = "info" | "warning" | "danger";

export const brandBanner: Record<BannerTone, string> = {
  info: "border-[#2563EB]/40 bg-[#DBEAFE]/50 text-[#1D4ED8] dark:border-[#2563eb59] dark:bg-[#2563eb14] dark:text-[#93C5FD]",
  warning: "border-[#F59E0B]/50 bg-[#FEF3C7]/60 text-[#B45309] dark:border-[#f59e0b59] dark:bg-[#f59e0b12] dark:text-[#F59E0B]",
  // PAP-14031: aligned to the proven `failed`/`error` chip recipe (danger soft
  // fill / foreground pair) so title + body both clear WCAG AA 4.5:1 in light and
  // dark on either `--background` or `--card`. The prior `text-destructive` on
  // `bg-destructive/10` measured ~3.7–4.3:1 — under AA for normal text. Border
  // keeps the destructive hue for continuity with other danger surfaces.
  danger: "border-destructive/40 bg-status-danger-soft text-status-danger-foreground",
};

export const issueStatusColor: Record<string, BrandChipColor> = {
  backlog: "gray",
  todo: "amber",
  in_progress: "blue",
  in_review: "violet",
  done: "green",
  blocked: "red",
  cancelled: "gray",
};

export const issueStatusColorDefault: BrandChipColor = "gray";

// ---------------------------------------------------------------------------
// Status → base-hue CSS variable
//
// Each status chip / icon sets a local `--sc` to the matching var below, and
// the `.status-chip` / `.status-fill` helpers (index.css) derive the rendered
// fill/text/border from it for both light and dark. Agent and task keep
// independent vars so each can be tuned without touching the other, even where
// their defaults coincide.
// ---------------------------------------------------------------------------

/** Agent status → base-hue CSS var. `active` aliases idle (never assigned). */
export const agentStatusVar: Record<string, string> = {
  idle: "--status-agent-idle",
  active: "--status-agent-idle",
  running: "--status-agent-running",
  paused: "--status-agent-paused",
  error: "--status-agent-error",
};
export const agentStatusVarDefault = "--status-agent-idle";

/** Task/issue status → base-hue CSS var (drives both the chip and the icon). */
export const taskStatusVar: Record<string, string> = {
  idle: "--status-task-backlog",
  backlog: "--status-task-backlog",
  todo: "--status-task-todo",
  in_progress: "--status-task-in_progress",
  in_review: "--status-task-in_review",
  done: "--status-task-done",
  blocked: "--status-task-blocked",
  cancelled: "--status-task-cancelled",
};
export const taskStatusVarDefault = "--status-task-backlog";

/**
 * Task/issue status → AA-tuned ICON-hue CSS var (PAP-238). Drives the standalone
 * {@link StatusGlyph} colour. Separate from {@link taskStatusVar} (the chip base
 * hue) because a bare glyph next to text needs a stronger hue to clear WCAG 3:1;
 * see the `--status-task-icon-*` block in `index.css`. `in_queue` is the blocked
 * shape recoloured blue, so it maps to its own var.
 */
export const taskStatusIconVar: Record<string, string> = {
  idle: "--status-task-icon-backlog",
  backlog: "--status-task-icon-backlog",
  todo: "--status-task-icon-todo",
  in_progress: "--status-task-icon-in_progress",
  in_review: "--status-task-icon-in_review",
  done: "--status-task-icon-done",
  blocked: "--status-task-icon-blocked",
  cancelled: "--status-task-icon-cancelled",
  in_queue: "--status-task-icon-in_queue",
  waiting: "--status-task-icon-in_progress",
};
export const taskStatusIconVarDefault = "--status-task-icon-backlog";

// ---------------------------------------------------------------------------
// Agent status dot — solid background for small indicator dots
// ---------------------------------------------------------------------------

export const agentStatusDot: Record<string, string> = {
  running: "bg-status-running animate-pulse", // Gallery feedback r1: running dot = blue, not cyan.
  active: "bg-status-success",
  paused: "bg-status-pending",
  idle: "bg-status-pending",
  pending_approval: "bg-status-warning",
  error: "bg-status-danger",
  archived: "bg-status-neutral",
};

export const agentStatusDotDefault = "bg-status-neutral";

// ---------------------------------------------------------------------------
// Priority colors
// ---------------------------------------------------------------------------

export const priorityColor: Record<string, string> = {
  critical: "text-status-danger",
  high: "text-status-alert",
  medium: "text-status-pending",
  low: "text-status-running",
};

export const priorityColorDefault = "text-status-pending";

// ---------------------------------------------------------------------------
// External object status — colors & severity ranking
// ---------------------------------------------------------------------------
//
// Categories come from `EXTERNAL_OBJECT_STATUS_CATEGORIES` in @greatstone/shared.
// The map keys here intentionally mirror the union — keep them in sync.
//
// Tone reuse rationale (see UX spec §1):
//   unknown   → backlog hue (muted, dashed circle)
//   open      → todo / blue
//   waiting   → amber (distinct from internal in_progress yellow)
//   running   → status blue (gallery r2; was cyan), animated when motion is allowed
//   succeeded → done / green
//   failed    → red
//   blocked   → red
//   closed    → muted neutral
//   archived  → muted neutral
//   auth_required → amber + dashed
//   unreachable   → red + dashed

export const externalObjectStatusIcon: Record<string, string> = {
  unknown: "text-muted-foreground border-muted-foreground",
  open: "text-status-running border-status-running",
  waiting: "text-status-warning border-status-warning",
  running: "text-status-running border-status-running", // Gallery feedback r2: running = status blue (pulse animation still distinguishes it from static blue `open`).
  succeeded: "text-status-success border-status-success",
  merged: "text-status-review border-status-review",
  failed: "text-status-danger border-status-danger",
  blocked: "text-status-danger border-status-danger",
  closed: "text-status-neutral border-status-neutral",
  archived: "text-status-neutral border-status-neutral",
  auth_required: "text-status-warning border-status-warning",
  unreachable: "text-status-danger border-status-danger",
};

export const externalObjectStatusIconDefault = "text-muted-foreground border-muted-foreground";

export const externalObjectStatusBadge: Record<string, string> = {
  unknown: "bg-muted text-muted-foreground",
  open: "bg-status-running-soft text-status-running-foreground",
  waiting: "bg-status-warning-soft text-status-warning-foreground",
  running: "bg-status-running-soft text-status-running-foreground", // Gallery feedback r2: running = status blue (now shares tint with `open`; liveness animation differentiates).
  succeeded: "bg-status-success-soft text-status-success-foreground",
  failed: "bg-status-danger-soft text-status-danger-foreground",
  blocked: "bg-status-danger-soft text-status-danger-foreground",
  closed: "bg-muted text-muted-foreground",
  archived: "bg-muted text-muted-foreground",
  auth_required: "bg-status-warning-soft text-status-warning-foreground",
  unreachable: "bg-status-danger-soft text-status-danger-foreground",
};

export const externalObjectStatusBadgeDefault = "bg-muted text-muted-foreground";

/**
 * Liveness overlay applied on top of the base status tone. We deliberately
 * encode it as utility classes (not a tone change) so callers can append the
 * overlay to any pill, icon, or marker without redefining colors.
 *
 * The dashed border + reduced opacity guarantees a non-color differentiator
 * for stale / auth_required / unreachable per WCAG 1.4.1.
 */
export const externalObjectLivenessOverlay: Record<string, string> = {
  unknown: "",
  fresh: "",
  stale: "opacity-70 [border-style:dashed]",
  auth_required: "[border-style:dashed]",
  unreachable: "[border-style:dashed]",
};

/**
 * Severity ranking used by sidebar/list rollups. Higher number = more
 * attention-worthy. Anything ≤ `muted` should be hidden when summarising.
 */
export const externalObjectStatusToneSeverity: Record<string, number> = {
  muted: 0,
  neutral: 1,
  success: 2,
  info: 3,
  warning: 4,
  danger: 5,
};

export const externalObjectStatusToneSeverityDefault = 0;

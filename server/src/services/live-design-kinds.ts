import type { DeliverableKind } from "@greatstone/shared";

/** What live design must respect for each kind of deliverable, beyond "edit the page". */
export const LIVE_KIND_GUIDANCE: Record<DeliverableKind, string | undefined> = {
  deck:
    "This is a slide deck. Keep every slide and its order, the slide navigation and the 16:9 frame; change only the slide John points at unless he asks for the whole deck. One idea per slide, short captions.",
  email:
    "This is an email template. Keep it email-safe: table layout, inline styles, a 600 px wide body, no scripts, no web fonts beyond a system fallback, and alt text on every image.",
  proposal:
    "This is a client proposal. Keep its sections (Executive Summary, Scope, Pricing, Next Steps and the rest) and their order, every figure exactly as written unless John changes it, and the print layout for A4.",
  mockup:
    "This is a UI mockup for GSAM or a client product. Keep it a realistic screen at its intended width; change layout and styling freely, but keep the data shown plausible and the controls labelled.",
  report: "This is a report. Keep its headings, figures and sources exactly as written unless John changes them, and the print layout for A4.",
  brief: undefined,
  plan: undefined,
  other: undefined,
};

/**
 * Shared visual contract for the Skills and Apps contextual navigation rails.
 *
 * Keep these surfaces on the same token-backed spacing and typography so their
 * navigation hierarchy cannot drift as either area evolves.
 */
export const contextualSidebarStyles = {
  nav: "flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-auto-hide px-3 py-2",
  group: "flex flex-col gap-0.5",
  // The label is the divider: brand gem, label, then a hairline that fades
  // out (gs-prop-heading), instead of a flat border above each section.
  section: "mt-5",
  sectionLabel:
    "gs-prop-heading px-2 pb-1.5 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground",
  sectionDescription:
    "px-4 pb-1.5 text-(length:--text-micro) leading-snug text-subtle-foreground",
} as const;

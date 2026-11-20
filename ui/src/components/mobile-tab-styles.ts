// One look for every tab in the phone bottom bar (MobileBottomNav and the
// Everest Messages tab in EverestOrb), so the six labels sit on one baseline.
export const mobileTabStyles = {
  /** The whole cell: icon slot above the label, centred in the 64px row. */
  tab: "relative flex min-w-0 select-none flex-col items-center justify-center gap-1 rounded-md text-(length:--text-nano) font-medium transition-[color,transform] duration-(--motion-press) active:scale-95",
  /** The icon slot: the same box for an icon, a badge or the Everest stone. */
  iconSlot: "relative flex h-7 w-12 items-center justify-center rounded-full",
} as const;

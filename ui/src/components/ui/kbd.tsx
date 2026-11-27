import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * One keycap. Every shortcut hint in the app uses it, so a key looks the same
 * in the command palette, a tooltip and the shortcuts sheet: 20px tall, at
 * least as wide as it is tall, tabular so a column of hints lines up.
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-sans text-(length:--text-nano) font-medium leading-none text-muted-foreground tabular-nums",
        className
      )}
      {...props}
    />
  )
}

export { Kbd }

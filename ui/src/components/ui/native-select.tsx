import * as React from "react"

import { cn } from "@/lib/utils"

// A styled browser <select>. Use it where the Radix Select does not fit:
// options with an empty-string value, or disabled options with inline reasons.
// The focus ring matches Input, Textarea and SelectTrigger.
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "border-input bg-background h-9 w-full min-w-0 rounded-md border px-2 text-sm shadow-xs transition-(--tp-color-box-shadow) outline-none disabled:cursor-not-allowed disabled:opacity-60",
        "focus-visible:border-ring focus-visible:ring-field-halo focus-visible:shadow-(--gs-field-glow) focus-visible:ring-(length:--rad-3)",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { NativeSelect }

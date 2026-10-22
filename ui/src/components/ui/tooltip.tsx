"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

const HasTooltipProvider = React.createContext(false)

function TooltipProvider({
  delayDuration,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  // A provider nested in the app's one keeps the app delay unless it asks for its own.
  const nested = React.useContext(HasTooltipProvider)
  if (nested && delayDuration === undefined) return <>{props.children}</>
  return (
    <HasTooltipProvider.Provider value>
      <TooltipPrimitive.Provider
        data-slot="tooltip-provider"
        delayDuration={delayDuration ?? 0}
        {...props}
      />
    </HasTooltipProvider.Provider>
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  // Under the app's provider every tooltip shares its delay (and moving from
  // one tip to the next skips it). Without one (tests, portals, plugin
  // outlets) a tooltip brings its own, so it never crashes.
  const root = <TooltipPrimitive.Root data-slot="tooltip" {...props} />
  return React.useContext(HasTooltipProvider) ? root : <TooltipProvider>{root}</TooltipProvider>
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "bg-foreground text-background animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-popover w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs text-balance",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="bg-foreground fill-foreground z-raised size-2.5 translate-y-(--sz-calc-28) rotate-45 rounded-(--rad-2)" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

/**
 * The name of an icon-only control, shown on hover and on keyboard focus with
 * the app's tooltip (one look, one delay). Wrap exactly one control, give it
 * an aria-label, and no `title`: the browser's own tip would show as well.
 */
// It also passes on whatever a parent trigger (a Popover's or a menu's asChild)
// gives it, so it can sit inside or outside another trigger.
const IconTip = React.forwardRef<
  HTMLElement,
  {
    label: React.ReactNode
    side?: React.ComponentProps<typeof TooltipPrimitive.Content>["side"]
    /** No tip (the control shows its words), but the same tree, so focus survives a switch. */
    off?: boolean
    children: React.ReactElement
  } & React.HTMLAttributes<HTMLElement>
>(function IconTip({ label, side, off = false, children, ...triggerProps }, ref) {
  return (
    <Tooltip open={off ? false : undefined}>
      <TooltipTrigger asChild ref={ref as React.Ref<HTMLButtonElement>} {...triggerProps}>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
})

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, IconTip }

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Tabs as TabsPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "p-(--sz-3px) group-data-[orientation=horizontal]/tabs:h-9 group/tabs-list text-muted-foreground inline-flex w-fit items-center justify-center group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col",
  {
    variants: {
      variant: {
        default: "rounded-lg bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

/**
 * Measures the active trigger into --gs-tab-* custom properties on the list so
 * one indicator can slide between tabs (see .gs-tab-indicator). Reports false
 * until a real measurement exists (no layout in tests, hidden lists), and the
 * triggers keep their own static active style until then.
 */
function useSlidingTabIndicator(listRef: React.RefObject<HTMLDivElement | null>) {
  const [sliding, setSliding] = React.useState(false)

  React.useLayoutEffect(() => {
    const list = listRef.current
    if (!list || typeof ResizeObserver === "undefined") return

    let frame = 0
    const measure = () => {
      const active = list.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
      const rect = active?.getBoundingClientRect()
      if (!active || !rect || rect.width === 0 || rect.height === 0) {
        setSliding(false)
        return
      }
      const box = list.getBoundingClientRect()
      list.style.setProperty("--gs-tab-x", `${rect.left - box.left - list.clientLeft + list.scrollLeft}px`)
      list.style.setProperty("--gs-tab-y", `${rect.top - box.top - list.clientTop + list.scrollTop}px`)
      list.style.setProperty("--gs-tab-w", `${rect.width}px`)
      list.style.setProperty("--gs-tab-h", `${rect.height}px`)
      list.style.setProperty("--gs-tab-r", getComputedStyle(active).borderTopLeftRadius)
      setSliding(true)
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }

    measure()
    const mutations = new MutationObserver(schedule)
    mutations.observe(list, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] })
    const resizes = new ResizeObserver(schedule)
    resizes.observe(list)
    list.querySelectorAll('[role="tab"]').forEach((tab) => resizes.observe(tab))

    return () => {
      cancelAnimationFrame(frame)
      mutations.disconnect()
      resizes.disconnect()
    }
  }, [listRef])

  return sliding
}

function TabsList({
  className,
  variant = "default",
  children,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  const listRef = React.useRef<HTMLDivElement>(null)
  const sliding = useSlidingTabIndicator(listRef)

  return (
    <TabsPrimitive.List
      ref={listRef}
      data-slot="tabs-list"
      data-variant={variant}
      data-indicator={sliding ? "sliding" : "static"}
      className={cn("relative", tabsListVariants({ variant }), className)}
      {...props}
    >
      {/* First child so the triggers paint above it. */}
      <span aria-hidden="true" data-slot="tabs-indicator" className="gs-tab-indicator" />
      {children}
    </TabsPrimitive.List>
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring text-muted-foreground hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground relative inline-flex h-(--sz-calc-27) flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-(--tp-color-background-color-border-color-box-shadow) group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start focus-visible:ring-(length:--rad-3) focus-visible:outline-1 disabled:pointer-events-none disabled:text-subtle-foreground group-data-[variant=default]/tabs-list:group-data-[indicator=static]/tabs-list:data-[state=active]:shadow-sm group-data-[variant=line]/tabs-list:data-[state=active]:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:border-transparent dark:group-data-[variant=line]/tabs-list:data-[state=active]:bg-transparent",
        "group-data-[indicator=static]/tabs-list:data-[state=active]:bg-background dark:data-[state=active]:text-foreground dark:group-data-[indicator=static]/tabs-list:data-[state=active]:border-input dark:group-data-[indicator=static]/tabs-list:data-[state=active]:bg-input/30 data-[state=active]:text-foreground",
        "after:bg-foreground after:absolute after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-(--sz-neg-5px) group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:group-data-[indicator=static]/tabs-list:data-[state=active]:after:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }

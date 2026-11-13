import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSidebar } from "../context/SidebarContext";

export interface PageTabItem {
  value: string;
  label: ReactNode;
  /** A count beside the label (a badge on desktop, "(n)" on phones). */
  count?: number;
}

interface PageTabBarProps {
  items: readonly PageTabItem[];
  value?: string;
  onValueChange?: (value: string) => void;
  align?: "center" | "start";
  /** Names the tab list, and the phone select; give nested tab bars their own name. */
  ariaLabel?: string;
  /** Shown above the phone select, for pages that stack two of them. */
  mobileLabel?: string;
}

export function PageTabBar({ items, value, onValueChange, align = "center", ariaLabel = "Page section", mobileLabel }: PageTabBarProps) {
  const { isMobile } = useSidebar();

  if (isMobile && value !== undefined && onValueChange) {
    const select = (
      <div className="relative inline-flex">
        <select
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          className="h-9 w-full appearance-none rounded-md border border-border bg-background pl-3 pr-9 py-1 text-base focus:outline-none focus:ring-1 focus:ring-ring"
          aria-label={ariaLabel}
        >
          {items.map((item) => (
            <option key={item.value} value={item.value}>
              {typeof item.label === "string" ? item.label : item.value}
              {item.count !== undefined ? ` (${item.count})` : ""}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      </div>
    );
    if (!mobileLabel) return select;
    return (
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{mobileLabel}</span>
        {select}
      </label>
    );
  }

  return (
    <TabsList variant="line" aria-label={ariaLabel} className={align === "start" ? "justify-start" : undefined}>
      {items.map((item) => (
        <TabsTrigger key={item.value} value={item.value}>
          {item.label}
          {item.count !== undefined ? (
            <span
              data-testid={`page-tab-count-${item.value}`}
              className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums text-muted-foreground"
            >
              {item.count}
            </span>
          ) : null}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

import { useState, type ReactNode } from "react";
import { ExternalLink, Settings2, X } from "lucide-react";
import { applyCompanyPrefix } from "@/lib/company-routes";
import { useActiveCompanyPrefix } from "@/lib/router";
import { Button } from "@/components/ui/button";

// An agent writes [Open the secrets settings](gsam-settings:/company/settings/secrets) in a task, and the
// person changes the setting in a small GSAM window right there, then closes it and carries on.
export const SETTINGS_WINDOW_HREF_PREFIX = "gsam-settings:";
// The frame's window.name survives navigation inside it, so Layout can drop its chrome on every page.
export const SETTINGS_WINDOW_FRAME_NAME = "gsam-settings-window";

/** What a gsam-settings: link opens: an in-app path, an https page elsewhere (Netlify, Stripe), or null. */
export function settingsWindowPath(href: string | null | undefined): string | null {
  if (!href?.startsWith(SETTINGS_WINDOW_HREF_PREFIX)) return null;
  const path = href.slice(SETTINGS_WINDOW_HREF_PREFIX.length).trim();
  if (/^\/(?![/\\])[^\s]*$/.test(path)) return path;
  return /^https:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(path) ? path : null;
}

export function isSettingsWindowFrame(): boolean {
  return typeof window !== "undefined" && window.self !== window.top && window.name === SETTINGS_WINDOW_FRAME_NAME;
}

export function SettingsWindow({ path, label }: { path: string; label: ReactNode }) {
  const [open, setOpen] = useState(false);
  const src = applyCompanyPrefix(path, useActiveCompanyPrefix());
  // Other sites (Netlify, Stripe) refuse to be framed, so they open in a small window beside GSAM.
  if (path.startsWith("https://")) {
    return (
      <Button type="button" variant="outline" size="sm" className="my-1 gap-1.5" onClick={() => window.open(path, SETTINGS_WINDOW_FRAME_NAME, "popup,noopener,width=1100,height=760")}>
        <ExternalLink className="size-3.5" aria-hidden />
        {label}
      </Button>
    );
  }
  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" className="my-1 gap-1.5" onClick={() => setOpen(true)}>
        <Settings2 className="size-3.5" aria-hidden />
        {label}
      </Button>
    );
  }
  return (
    <span className="my-2 block overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <span className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <Settings2 className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{label}</span>
        <a href={src} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" aria-label="Open in a full tab">
          <ExternalLink className="size-3.5" />
        </a>
        <Button type="button" size="sm" className="h-7" onClick={() => setOpen(false)}>
          Done
        </Button>
        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)} aria-label="Close settings window">
          <X className="size-4" />
        </button>
      </span>
      <iframe name={SETTINGS_WINDOW_FRAME_NAME} src={src} title={typeof label === "string" ? label : "Settings"} className="block w-full bg-background" style={{ height: "min(560px, 70vh)" }} />
    </span>
  );
}

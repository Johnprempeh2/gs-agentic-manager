import { useState, type ReactNode } from "react";
import { intelligenceDomain } from "@greatstone/shared";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";

// Logos and article images come from our own server (GRE-405: the browser
// never loads a remote host). A miss is a monogram or a quiet panel, never a
// broken image.

const mediaBase = (companyId: string) => `/api/companies/${encodeURIComponent(companyId)}/intelligence`;

// Soft status pairs clear AA in both themes, so the monogram reads everywhere.
const MONOGRAM_TONES = [
  "bg-status-info-soft text-status-info-foreground",
  "bg-status-review-soft text-status-review-foreground",
  "bg-status-running-soft text-status-running-foreground",
  "bg-status-success-soft text-status-success-foreground",
  "bg-status-pending-soft text-status-pending-foreground",
  "bg-status-alert-soft text-status-alert-foreground",
];

export function monogram(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : words[0]!.slice(0, 2);
  return letters.toUpperCase();
}

function toneFor(seed: string) {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return MONOGRAM_TONES[hash % MONOGRAM_TONES.length]!;
}

const LOGO_SIZES = {
  sm: { box: "size-6 rounded-md text-xs", pad: "p-0.5" },
  md: { box: "size-8 rounded-md text-xs", pad: "p-1" },
  lg: { box: "size-10 rounded-lg text-sm", pad: "p-1.5" },
  xl: { box: "size-14 rounded-lg text-base", pad: "p-2" },
} as const;
export type BrandLogoSize = keyof typeof LOGO_SIZES;

/**
 * A brand logo on a light chip (marks are drawn for white), from the item's
 * `domain` or its URL's host. No Logo.dev key, no match or no domain: the
 * name's initials on a token-coloured chip.
 */
export function BrandLogo({
  name,
  domain,
  url,
  size = "md",
  className,
}: {
  name: string;
  domain?: string | null;
  url?: string | null;
  size?: BrandLogoSize;
  className?: string;
}) {
  const { selectedCompanyId } = useCompany();
  const host = intelligenceDomain({ domain, url });
  const src = host && selectedCompanyId ? `${mediaBase(selectedCompanyId)}/logo/${encodeURIComponent(host)}` : null;
  const [failed, setFailed] = useState<string | null>(null);
  const { box, pad } = LOGO_SIZES[size];
  if (src && failed !== src) {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center overflow-hidden border border-border bg-background dark:bg-foreground",
          box,
          className,
        )}
        data-logo={host}
      >
        <img src={src} alt="" loading="lazy" decoding="async" className={cn("h-full w-full object-contain", pad)} onError={() => setFailed(src)} />
      </span>
    );
  }
  return (
    <span
      className={cn("inline-flex shrink-0 select-none items-center justify-center font-semibold", box, toneFor(name), className)}
      aria-hidden="true"
      data-monogram={monogram(name)}
    >
      {monogram(name)}
    </span>
  );
}

/**
 * The article's own preview image (its og:image, or `imageUrl` when the agent
 * gave one), lazy, in a fixed-ratio box so nothing shifts when it lands. With
 * no image, `fallback` fills the same box.
 */
export function ArticleImage({
  url,
  imageUrl,
  fallback,
  className,
}: {
  url: string;
  imageUrl?: string | null;
  fallback?: ReactNode;
  className?: string;
}) {
  const { selectedCompanyId } = useCompany();
  const src = selectedCompanyId ? `${mediaBase(selectedCompanyId)}/image?url=${encodeURIComponent(imageUrl ?? url)}` : null;
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <div className={cn("relative aspect-video overflow-hidden bg-muted", className)}>
      {src && failed !== src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
          onError={() => setFailed(src)}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">{fallback}</div>
      )}
    </div>
  );
}

/** Compact tag chip for a story's or tool's category. */
export function TagChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-block max-w-full truncate rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground", className)}>
      {children}
    </span>
  );
}

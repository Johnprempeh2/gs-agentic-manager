import { Globe, Link2Off, Lock } from "lucide-react";
import type { Deliverable, DeliverableConfidentiality } from "@/api/deliverables";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const CONFIDENTIALITY_LABELS: Record<DeliverableConfidentiality, string> = {
  internal: "Internal",
  client: "Client",
  public: "Public",
};

const CONFIDENTIALITY_HINTS: Record<DeliverableConfidentiality, string> = {
  internal: "Internal: never shown to the client",
  client: "Client: may reach the client portal once the NDA is accepted",
  public: "Public: may reach the client portal without an NDA",
};

/** Who may see the deliverable: internal, client or public. */
export function ConfidentialityBadge({ value, className }: { value: DeliverableConfidentiality; className?: string }) {
  return (
    <Badge
      variant="outline"
      title={CONFIDENTIALITY_HINTS[value]}
      data-testid="deliverable-confidentiality"
      className={cn(
        value === "internal" && "text-muted-foreground",
        value === "client" && "border-status-info/40 bg-status-info-soft text-status-info-foreground",
        value === "public" && "border-status-success/40 bg-status-success-soft text-status-success-foreground",
        className,
      )}
    >
      {CONFIDENTIALITY_LABELS[value]}
    </Badge>
  );
}

/** Small marks for a link deliverable: broken (last daily check failed) and password protected or unlisted. */
export function LinkStatusBadges({ deliverable }: { deliverable: Pick<Deliverable, "external" | "linkCheck" | "restricted"> }) {
  if (!deliverable.external) return null;
  const broken = deliverable.linkCheck !== null && !deliverable.linkCheck.ok;
  return (
    <>
      {broken ? (
        <Badge
          variant="outline"
          data-testid="deliverable-link-broken"
          title={deliverable.linkCheck?.httpStatus ? `The site answered ${deliverable.linkCheck.httpStatus}` : "The site could not be reached"}
          className="border-status-warning/40 bg-status-warning-soft text-status-warning-foreground"
        >
          <Link2Off aria-hidden="true" /> Link broken
        </Badge>
      ) : null}
      {deliverable.restricted ? (
        <Badge variant="outline" data-testid="deliverable-link-restricted" title="Password protected or unlisted" className="text-muted-foreground">
          <Lock aria-hidden="true" /> Protected
        </Badge>
      ) : null}
    </>
  );
}

/** The site's host without "www.", or the raw url when it does not parse. */
export function siteDomain(url: string | null) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Up to two letters from the site's first label, for the placeholder card ("greatstone-moengt-deck" gives "GM"). */
export function siteInitials(url: string | null) {
  const label = siteDomain(url).split(".")[0] ?? "";
  const words = label.split(/[^a-z0-9]+/i).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : label.slice(0, 2);
  return letters.toUpperCase() || "?";
}

/**
 * A link deliverable's stored screenshot, or a calm placeholder with the
 * site's initials and domain while there is none. Never loads the live site:
 * remote content in the app would tell a third party who looked (GRE-405).
 */
export function SiteThumbnail({
  source,
  large = false,
  className,
}: {
  source: Pick<Deliverable, "url" | "title" | "screenshotPath">;
  large?: boolean;
  className?: string;
}) {
  const domain = siteDomain(source.url);
  if (source.screenshotPath) {
    return (
      <img
        src={source.screenshotPath}
        alt={large ? `Screenshot of ${domain}` : ""}
        loading="lazy"
        data-testid="deliverable-site-screenshot"
        className={cn("h-full w-full object-cover object-top", large && "object-contain", className)}
      />
    );
  }
  return (
    <div
      data-testid="deliverable-site-placeholder"
      className={cn("flex h-full w-full flex-col items-center justify-center gap-2 bg-muted/40 text-muted-foreground", className)}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex items-center justify-center rounded-lg border border-border bg-background font-semibold text-foreground",
          large ? "h-16 w-16 text-xl" : "h-10 w-10 text-sm",
        )}
      >
        {siteInitials(source.url)}
      </span>
      <span className="flex max-w-full items-center gap-1 truncate px-4 text-xs">
        <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{domain}</span>
      </span>
    </div>
  );
}

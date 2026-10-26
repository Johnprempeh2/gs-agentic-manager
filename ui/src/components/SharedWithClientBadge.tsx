import { Eye, EyeOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/** Marks a record the client can see on their portal or website hub (GRE-2614). */
export function SharedWithClientBadge({ title = "The client can see this" }: { title?: string }) {
  return (
    <Badge variant="outline" title={title} data-testid="shared-with-client">
      <Eye aria-hidden="true" />
      Shared with client
    </Badge>
  );
}

/** The other side, so a missing badge is never the signal: the client cannot see this record. */
export function NotSharedBadge({ label = "Internal", title = "The client cannot see this" }: { label?: string; title?: string }) {
  return (
    <Badge variant="outline" title={title} className="text-muted-foreground" data-testid="not-shared-with-client">
      <EyeOff aria-hidden="true" />
      {label}
    </Badge>
  );
}

/** Shared with client, or the muted "not shared" marker. */
export function ClientVisibilityBadge({ shared, sharedTitle, notSharedLabel, notSharedTitle }: {
  shared: boolean;
  sharedTitle?: string;
  notSharedLabel?: string;
  notSharedTitle?: string;
}) {
  return shared ? <SharedWithClientBadge title={sharedTitle} /> : <NotSharedBadge label={notSharedLabel} title={notSharedTitle} />;
}

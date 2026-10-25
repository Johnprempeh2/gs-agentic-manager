import { Eye } from "lucide-react";
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

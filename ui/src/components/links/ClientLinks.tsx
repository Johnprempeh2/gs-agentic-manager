import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { linksApi } from "../../api/links";
import { queryKeys } from "../../lib/queryKeys";
import { AddLinkDialog, LinkRow } from "./LinkRow";

const SHOWN = 10;

/** A client page's Links section (GRE-4252): this client's links from the register. */
export function ClientLinks({ companyId, caseId }: { companyId: string; caseId: string }) {
  const [adding, setAdding] = useState(false);
  const params = { clientCaseId: caseId };
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.links.list(companyId, params),
    queryFn: () => linksApi.list(companyId, params),
  });
  const links = data?.links ?? [];
  const total = data?.total ?? links.length;

  return (
    <div data-testid="client-links">
      {isLoading ? (
        <p className="py-2 text-sm text-muted-foreground">Loading links...</p>
      ) : error ? (
        <p className="py-2 text-sm text-destructive">Could not load this client's links.</p>
      ) : links.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          No links yet. Sites, previews and deliverable links on this client's tasks appear here.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {links.slice(0, SHOWN).map((link) => (
            <LinkRow key={link.id} link={link} companyId={companyId} />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3 border-t border-border py-2">
        <Button type="button" size="xs" variant="ghost" onClick={() => setAdding(true)}>
          <Plus />
          Add link
        </Button>
        {total > 0 ? (
          <Link to={`/links?client=${encodeURIComponent(caseId)}`} className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            {total > SHOWN ? `See all ${total} links` : "Open in Links"}
          </Link>
        ) : null}
      </div>
      <AddLinkDialog companyId={companyId} open={adding} onOpenChange={setAdding} clientCaseId={caseId} />
    </div>
  );
}

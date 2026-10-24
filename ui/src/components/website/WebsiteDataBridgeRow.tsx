import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WebsiteDataBridgeKey, WebsiteSite } from "@greatstone/shared";
import { websiteDataBridgeApi } from "../../api/website-data-bridge";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { errorStateMessage } from "../ErrorState";

// "Website data" on Site connection (GRE-2323): whether GSAM can read the site's customer records through the
// signed admin bridge, and, for people with Publish rights, a button that makes the read key. The page only ever
// sees the public key, to add to the site's GSAM_BRIDGE_KEYS.

const SKEW_WARNING_SECONDS = 20;

export function WebsiteDataBridgeRow({ companyId, site, canManage }: { companyId: string; site: WebsiteSite; canManage: boolean }) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: queryKeys.website.dataBridge(companyId, site.id),
    queryFn: () => websiteDataBridgeApi.status(companyId, site.id),
    staleTime: 60_000,
    retry: false,
  });
  const [making, setMaking] = useState(false);
  const [environment, setEnvironment] = useState<"stg" | "live">("stg");
  const [url, setUrl] = useState("");
  const [made, setMade] = useState<WebsiteDataBridgeKey | null>(null);
  const create = useMutation({
    mutationFn: () => websiteDataBridgeApi.createKey(companyId, site.id, { environment, url: url.trim() ? url.trim() : undefined }),
    onSuccess: (key) => {
      setMade(key);
      setMaking(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.dataBridge(companyId, site.id) });
    },
  });
  const data = status.data;
  const skew = data?.clockSkewSeconds ?? null;

  return (
    <div className="min-w-0 space-y-1.5" data-testid="website-data-bridge">
      {status.isLoading ? (
        <span className="text-muted-foreground">Checking</span>
      ) : status.isError ? (
        <span role="alert" className="text-status-danger">{errorStateMessage(status.error)}</span>
      ) : data?.state === "connected" ? (
        <span>
          Connected. Read key <span className="font-mono">{data.keyId}</span>.
          {skew !== null && Math.abs(skew) > SKEW_WARNING_SECONDS ? ` The site's clock is ${skew} s off GSAM's.` : ""}
        </span>
      ) : data?.state === "failing" ? (
        <span>
          <span className="text-status-danger">Not reading.</span> {data.message} Read key <span className="font-mono">{data.keyId}</span>.
        </span>
      ) : (
        <span className="text-muted-foreground">Not set up. GSAM cannot read the site's customer records yet.</span>
      )}
      {made ? (
        <div className="space-y-1 rounded-md border p-2">
          <p>Add this entry to the site's <span className="font-mono">GSAM_BRIDGE_KEYS</span> list and redeploy the site. It is a public key, so it is safe to copy. A live site key goes on John's release task.</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px]" data-testid="website-data-bridge-entry">{JSON.stringify(made.keysEntry)}</pre>
          <div className="flex gap-2">
            <Button type="button" size="xs" variant="ghost" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(made.keysEntry))}>Copy</Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setMade(null)}>Done</Button>
          </div>
        </div>
      ) : null}
      {canManage && !made ? (
        making ? (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
            <label className="flex flex-col gap-0.5">
              <span className="text-muted-foreground">Site</span>
              <NativeSelect aria-label="Which site" value={environment} onChange={(event) => setEnvironment(event.target.value as "stg" | "live")}>
                <option value="stg">Staging</option>
                <option value="live">Live</option>
              </NativeSelect>
            </label>
            <label className="flex min-w-48 flex-1 flex-col gap-0.5">
              <span className="text-muted-foreground">Bridge address (optional)</span>
              <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder={data?.url ?? `https://${site.domain}`} />
            </label>
            <Button type="submit" size="xs" disabled={create.isPending}>{create.isPending ? "Making" : "Make read key"}</Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setMaking(false)} disabled={create.isPending}>Cancel</Button>
            {data?.keyId ? <p className="w-full text-muted-foreground">This replaces read key <span className="font-mono">{data.keyId}</span>. GSAM stops using the old key at once.</p> : null}
            {create.isError ? <p role="alert" className="w-full text-status-danger">{errorStateMessage(create.error)}</p> : null}
          </form>
        ) : (
          <Button type="button" size="xs" variant="ghost" onClick={() => setMaking(true)}>{data?.keyId ? "Make a new read key" : "Make read key"}</Button>
        )
      ) : null}
    </div>
  );
}

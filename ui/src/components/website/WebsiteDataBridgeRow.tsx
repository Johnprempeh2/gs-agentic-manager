import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WebsiteDataBridgeCapability, WebsiteDataBridgeKey, WebsiteDataBridgeStatus, WebsiteSite } from "@greatstone/shared";
import { websiteDataBridgeApi } from "../../api/website-data-bridge";
import { queryKeys } from "../../lib/queryKeys";
import { useCopyAction } from "../../lib/use-copy-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { errorStateMessage } from "../ErrorState";
import { formatCalendarMonth } from "@/lib/utils";

// "Website data" on Site connection (GRE-2323): whether GSAM can read the site's customer records through the
// signed admin bridge, one line per bridge key (read, write, refund_request; GRE-2552), and, for people with
// Publish rights, a button that makes a missing key. The page only ever sees the public key, to add to the site's
// GSAM_BRIDGE_KEYS.

const SKEW_WARNING_SECONDS = 20;

const KEY_LINES: { capability: WebsiteDataBridgeCapability; label: string; use: string }[] = [
  { capability: "read", label: "Read key", use: "reads" },
  { capability: "write", label: "Write key", use: "Deep Dive sync and commerce writes" },
  { capability: "refund_request", label: "Refund key", use: "refund requests" },
];

function keyIdFor(data: WebsiteDataBridgeStatus | undefined, capability: WebsiteDataBridgeCapability) {
  if (!data) return null;
  if (capability === "read") return data.keyId;
  return (capability === "write" ? data.writeKeyId : data.refundKeyId) ?? null;
}

/** The site and month a key was made for, from its id (`stg-read-2026-10-abc123`). */
export function describeBridgeKeyId(keyId: string) {
  const match = /^(stg|live)-[a-z]+-(\d{4})-(\d{2})-/.exec(keyId);
  if (!match) return null;
  return `${match[1] === "live" ? "Live" : "Staging"} site, made ${formatCalendarMonth(`${match[2]}-${match[3]}-01`)}`;
}

export function WebsiteDataBridgeRow({ companyId, site, canManage }: { companyId: string; site: WebsiteSite; canManage: boolean }) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: queryKeys.website.dataBridge(companyId, site.id),
    queryFn: () => websiteDataBridgeApi.status(companyId, site.id),
    staleTime: 60_000,
    retry: false,
  });
  const [making, setMaking] = useState<WebsiteDataBridgeCapability | null>(null);
  const [environment, setEnvironment] = useState<"stg" | "live">("stg");
  const [url, setUrl] = useState("");
  const [made, setMade] = useState<WebsiteDataBridgeKey | null>(null);
  const copyEntry = useCopyAction();
  const create = useMutation({
    mutationFn: (capability: WebsiteDataBridgeCapability) =>
      websiteDataBridgeApi.createKey(companyId, site.id, { environment, capability, url: url.trim() ? url.trim() : undefined }),
    onSuccess: (key) => {
      setMade(key);
      setMaking(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.dataBridge(companyId, site.id) });
    },
  });
  const data = status.data;
  const skew = data?.clockSkewSeconds ?? null;
  const startMaking = (capability: WebsiteDataBridgeCapability) => {
    create.reset();
    setMade(null);
    setMaking(capability);
  };

  return (
    <div className="min-w-0 space-y-1.5 break-normal" data-testid="website-data-bridge">
      {status.isLoading ? (
        <span className="text-muted-foreground">Checking</span>
      ) : status.isError ? (
        <span role="alert" className="text-status-danger">{errorStateMessage(status.error)}</span>
      ) : data?.state === "connected" ? (
        <span>
          Connected.
          {skew !== null && Math.abs(skew) > SKEW_WARNING_SECONDS ? ` The site's clock is ${skew} s off GSAM's.` : ""}
        </span>
      ) : data?.state === "failing" ? (
        <span>
          <span className="text-status-danger">Not reading.</span> {data.message}
        </span>
      ) : (
        <span className="text-muted-foreground">Not set up. GSAM cannot read the site's customer records yet.</span>
      )}
      {data ? (
        <ul className="space-y-1">
          {KEY_LINES.map(({ capability, label, use }) => {
            const keyId = keyIdFor(data, capability);
            const about = keyId ? describeBridgeKeyId(keyId) : null;
            return (
              <li key={capability} className="space-y-1" data-testid={`website-data-bridge-key-${capability}`}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="w-20 shrink-0 text-muted-foreground" title={`For ${use}`}>{label}</span>
                  {keyId ? (
                    <>
                      <span className="break-all font-mono">{keyId}</span>
                      {about ? <span className="text-muted-foreground">{about}</span> : null}
                    </>
                  ) : (
                    <span className="text-muted-foreground">Not set</span>
                  )}
                  {canManage && making !== capability ? (
                    <Button type="button" size="xs" variant="ghost" onClick={() => startMaking(capability)}>
                      {keyId ? "Make a new key" : "Make key"}
                    </Button>
                  ) : null}
                </div>
                {canManage && making === capability ? (
                  <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); create.mutate(capability); }}>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-muted-foreground">Site</span>
                      <NativeSelect aria-label="Which site" value={environment} onChange={(event) => setEnvironment(event.target.value as "stg" | "live")}>
                        <option value="stg">Staging</option>
                        <option value="live">Live</option>
                      </NativeSelect>
                    </label>
                    <label className="flex min-w-48 flex-1 flex-col gap-0.5">
                      <span className="text-muted-foreground">Bridge address (optional)</span>
                      <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder={data.url || `https://${site.domain}`} />
                    </label>
                    <Button type="submit" size="xs" disabled={create.isPending}>{create.isPending ? "Making" : `Make ${label.toLowerCase()}`}</Button>
                    <Button type="button" size="xs" variant="ghost" onClick={() => setMaking(null)} disabled={create.isPending}>Cancel</Button>
                    {keyId ? <p className="w-full text-muted-foreground">This replaces {label.toLowerCase()} <span className="font-mono">{keyId}</span>. GSAM stops using the old key at once.</p> : null}
                    {create.isError ? <p role="alert" className="w-full text-status-danger">{errorStateMessage(create.error)}</p> : null}
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {made ? (
        <div className="space-y-1 rounded-md border p-2">
          <p>Add this entry to the site's <span className="font-mono">GSAM_BRIDGE_KEYS</span> list and redeploy the site. It is a public key, so it is safe to copy. A live site key goes on John's release task.</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-micro" data-testid="website-data-bridge-entry">{JSON.stringify(made.keysEntry)}</pre>
          <div className="flex gap-2">
            <Button type="button" size="xs" variant="ghost" onClick={() => void copyEntry.copy(JSON.stringify(made.keysEntry))}>
              {copyEntry.copied ? "Copied" : copyEntry.failed ? "Could not copy" : "Copy"}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setMade(null)}>Done</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

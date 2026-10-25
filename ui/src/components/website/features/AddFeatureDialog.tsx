import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { WEBSITE_FEATURE_ICONS, type WebsiteFeatureIcon } from "@greatstone/shared";
import { websiteFeaturesApi } from "../../../api/website-features";
import { queryKeys } from "../../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ErrorState } from "../../ErrorState";
import { parseLines } from "./feature-settings";

// A blank feature form (GRE-2325): name, purpose, icon and routes. The server
// makes the key from the name; owner, lead agent, project and collections are
// set later in the feature's Settings.

export function AddFeatureDialog({
  companyId,
  siteId,
  open,
  onOpenChange,
}: {
  companyId: string;
  siteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [icon, setIcon] = useState<WebsiteFeatureIcon>("blocks");
  const [routes, setRoutes] = useState("");

  const reset = () => {
    setName("");
    setPurpose("");
    setIcon("blocks");
    setRoutes("");
  };
  const create = useMutation({
    mutationFn: () =>
      websiteFeaturesApi.create(companyId, siteId, { name: name.trim(), purpose: purpose.trim(), icon, routePrefixes: parseLines(routes) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.website.features(companyId, siteId) });
      reset();
      onOpenChange(false);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) create.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) create.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="website-add-feature-dialog">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add a feature</DialogTitle>
            <DialogDescription>A big part of the site, like a shop or a client portal. You can set an owner and a project after.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <div className="flex min-w-0 flex-col gap-1 text-sm">
              <label htmlFor="new-feature-name" className="font-medium">Name</label>
              <Input id="new-feature-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} autoFocus />
            </div>
            <div className="flex min-w-0 flex-col gap-1 text-sm">
              <label htmlFor="new-feature-icon" className="font-medium">Icon</label>
              <NativeSelect id="new-feature-icon" value={icon} onChange={(event) => setIcon(event.target.value as WebsiteFeatureIcon)}>
                {WEBSITE_FEATURE_ICONS.map((entry) => <option key={entry} value={entry}>{entry.replace(/-/g, " ")}</option>)}
              </NativeSelect>
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-1 text-sm">
            <label htmlFor="new-feature-purpose" className="font-medium">Purpose</label>
            <Textarea id="new-feature-purpose" value={purpose} onChange={(event) => setPurpose(event.target.value)} maxLength={280} rows={2} aria-describedby="new-feature-purpose-help" />
            <p id="new-feature-purpose-help" className="text-xs text-muted-foreground">One or two sentences: what this part of the site is for.</p>
          </div>
          <div className="flex min-w-0 flex-col gap-1 text-sm">
            <label htmlFor="new-feature-routes" className="font-medium">Routes</label>
            <Textarea id="new-feature-routes" value={routes} onChange={(event) => setRoutes(event.target.value)} rows={3} className="font-mono text-xs" aria-describedby="new-feature-routes-help" />
            <p id="new-feature-routes-help" className="text-xs text-muted-foreground">One path per line, like /shop. A page belongs to the feature with the longest matching route.</p>
          </div>
          {create.error ? <ErrorState error={create.error} compact /> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>{create.isPending ? "Adding" : "Add feature"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

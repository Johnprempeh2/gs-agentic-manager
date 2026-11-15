import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FlaskConical, History, ImageUp } from "lucide-react";
import { PROTOTYPE_STATUS_LABELS, type PrototypeSettableStatus, type PrototypeStatus } from "@greatstone/shared";
import { prototypesApi, type Prototype } from "@/api/prototypes";
import { EmptyState } from "@/components/EmptyState";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useOptionalToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { formatDate } from "@/lib/utils";

// Prototypes (John, 14 Nov): every prototype across clients. The same list
// shows on the Prototypes page (with filters), a client's page and a project
// (fixed to that client or project). Only a person shows one to a client, and
// only after a confirm that names the client.

const STATUS_BADGE: Record<PrototypeStatus, "default" | "secondary" | "outline"> = {
  draft: "outline",
  in_review: "secondary",
  shared: "default",
  retired: "outline",
};

export function PrototypeList({
  companyId,
  organisationId,
  projectId,
  filters = false,
}: {
  companyId: string;
  organisationId?: string;
  projectId?: string;
  /** Show client, project and status filters (the Prototypes page). */
  filters?: boolean;
}) {
  const [client, setClient] = useState("");
  const [project, setProject] = useState("");
  const [status, setStatus] = useState<PrototypeStatus | "">("");
  const params = { organisationId, projectId };
  const query = useQuery({
    queryKey: queryKeys.prototypes.list(companyId, params),
    queryFn: () => prototypesApi.list(companyId, params),
    enabled: !!companyId,
  });
  const all = query.data?.prototypes ?? [];
  const clients = useMemo(() => uniqueBy(all.flatMap((item) => (item.client ? [item.client] : []))), [all]);
  const projects = useMemo(() => uniqueBy(all.flatMap((item) => (item.project ? [item.project] : []))), [all]);
  const shown = all.filter((item) =>
    (!client || item.client?.id === client) && (!project || item.project?.id === project) && (!status || item.prototypeStatus === status));

  if (query.isLoading) return <p className="text-sm text-muted-foreground">Loading prototypes…</p>;
  if (query.error) return <p className="text-sm text-destructive" role="alert">Could not load prototypes. Try again.</p>;
  if (all.length === 0) {
    return (
      <EmptyState
        icon={FlaskConical}
        message="No prototypes yet. When an agent or a person deploys a prototype site and registers it, it shows here as Internal."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {filters ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter prototypes">
          <NativeSelect aria-label="Client" value={client} onChange={(event) => setClient(event.target.value)} className="h-9 w-auto text-sm">
            <option value="">All clients</option>
            {clients.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </NativeSelect>
          <NativeSelect aria-label="Project" value={project} onChange={(event) => setProject(event.target.value)} className="h-9 w-auto text-sm">
            <option value="">All projects</option>
            {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </NativeSelect>
          <NativeSelect aria-label="Status" value={status} onChange={(event) => setStatus(event.target.value as PrototypeStatus | "")} className="h-9 w-auto text-sm">
            <option value="">Any status</option>
            {Object.entries(PROTOTYPE_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </NativeSelect>
        </div>
      ) : null}
      {shown.length === 0 ? <p className="text-sm text-muted-foreground">No prototypes match these filters.</p> : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Prototypes">
          {shown.map((item) => <PrototypeCard key={item.id} companyId={companyId} prototype={item} />)}
        </ul>
      )}
    </div>
  );
}

function uniqueBy<T extends { id: string; name: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()].sort((a, b) => a.name.localeCompare(b.name));
}

function PrototypeCard({ companyId, prototype }: { companyId: string; prototype: Prototype }) {
  const queryClient = useQueryClient();
  const toast = useOptionalToastActions();
  const [confirming, setConfirming] = useState<boolean | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.prototypes.all(companyId) });
  const fail = (error: unknown) => toast?.pushToast({ title: "That did not work", body: error instanceof Error ? error.message : undefined, tone: "error" });

  const visibility = useMutation({
    mutationFn: (visible: boolean) => prototypesApi.setVisibility(companyId, prototype.id, { visible, organisationId: prototype.client!.id }),
    onSuccess: (result, visible) => {
      if (result.portal.error) {
        toast?.pushToast({ title: visible ? "Saved, but the portal was not updated" : "Hidden in GSAM, but the portal was not updated", body: result.portal.error, tone: "warn" });
      } else {
        toast?.pushToast({ title: visible ? `Now visible to ${prototype.client!.name}` : `Removed from ${prototype.client!.name}'s portal`, tone: "success" });
      }
      void refresh();
    },
    onError: fail,
  });
  const statusChange = useMutation({
    mutationFn: (next: PrototypeSettableStatus) => prototypesApi.setStatus(companyId, prototype.id, next),
    onSuccess: () => void refresh(),
    onError: fail,
  });
  const upload = useMutation({
    mutationFn: (file: File) => prototypesApi.uploadScreenshot(companyId, prototype.id, file),
    onSuccess: () => void refresh(),
    onError: fail,
  });

  const client = prototype.client;
  const canShare = !!client?.websiteLinked && prototype.prototypeStatus !== "retired";
  const shareHint = !client
    ? "File it under a client's task or project to share it."
    : !client.websiteLinked
      ? `Link ${client.name} to its website organisation first.`
      : prototype.prototypeStatus === "retired"
        ? "Retired prototypes cannot be shared."
        : prototype.portal.needsReshare
          ? "The latest version is at a new address. Turn this on again to share it."
          : null;
  const settable: PrototypeSettableStatus = prototype.prototypeStatus === "shared" ? "in_review" : prototype.prototypeStatus;

  return (
    <li className="flex flex-col overflow-hidden rounded-lg border border-border bg-card" data-testid="prototype-card">
      <a href={prototype.url ?? undefined} target="_blank" rel="noopener noreferrer" className="block aspect-video bg-muted" aria-label={`Open ${prototype.title} in a new tab`}>
        {prototype.screenshotPath ? (
          <img src={prototype.screenshotPath} alt="" className="h-full w-full object-cover object-top" loading="lazy" />
        ) : (
          <span className="flex h-full items-center justify-center text-sm text-muted-foreground">No screenshot yet</span>
        )}
      </a>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 break-words text-sm font-semibold">{prototype.title}</h3>
          <Badge variant={STATUS_BADGE[prototype.prototypeStatus]}>{PROTOTYPE_STATUS_LABELS[prototype.prototypeStatus]}</Badge>
        </div>
        {prototype.summary ? <p className="text-sm text-muted-foreground">{prototype.summary}</p> : null}
        <dl className="space-y-1 text-xs">
          {([
            ["Client", client?.name ?? "Not filed under a client"],
            ["Project", prototype.project?.name ?? "None"],
            ["Owner", prototype.owner?.name ?? "Unassigned"],
            ["Updated", `${formatDate(prototype.createdAt)} (version ${prototype.version})`],
          ] as const).map(([label, value]) => (
            <div key={label} className="flex gap-3"><dt className="w-16 shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{value}</dd></div>
          ))}
        </dl>
        <div className="flex flex-wrap gap-2">
          {prototype.url ? (
            <Button asChild size="sm" variant="outline">
              <a href={prototype.url} target="_blank" rel="noopener noreferrer"><ExternalLink />Open</a>
            </Button>
          ) : null}
          <Button asChild size="sm" variant="outline">
            <Link to={`/deliverables?open=${prototype.id}`}><History />Versions</Link>
          </Button>
          {!prototype.screenshotPath ? (
            <>
              <Button size="sm" variant="outline" disabled={upload.isPending} onClick={() => fileInput.current?.click()}><ImageUp />Upload screenshot</Button>
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Screenshot file"
                onChange={(event) => { const file = event.target.files?.[0]; if (file) upload.mutate(file); event.target.value = ""; }} />
            </>
          ) : null}
        </div>
        <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
          <label className="flex items-center justify-between gap-2 text-sm">
            <span>Status</span>
            <NativeSelect aria-label={`Status of ${prototype.title}`} value={settable} disabled={statusChange.isPending}
              onChange={(event) => statusChange.mutate(event.target.value as PrototypeSettableStatus)} className="h-9 w-auto text-sm">
              <option value="draft">Draft</option>
              <option value="in_review">In review</option>
              <option value="retired">Retired</option>
            </NativeSelect>
          </label>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span id={`visible-${prototype.id}`}>Visible to {client?.name ?? "the client"}</span>
            <ToggleSwitch
              aria-labelledby={`visible-${prototype.id}`}
              checked={prototype.portal.visible}
              disabled={visibility.isPending || (!prototype.portal.visible && !canShare)}
              onCheckedChange={(next) => setConfirming(next)}
            />
          </div>
          {shareHint ? <p className="text-xs text-muted-foreground">{shareHint}</p> : null}
        </div>
      </div>
      <AlertDialog open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming ? `Show this prototype to ${client?.name}?` : `Remove it from ${client?.name}'s portal?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming
                ? `Everyone at ${client?.name} who signs in to the client portal will see "${prototype.title}" and can open ${prototype.url}. Nobody else sees it.`
                : `"${prototype.title}" leaves ${client?.name}'s portal straight away. It stays here in GSAM.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (confirming !== null) visibility.mutate(confirming); setConfirming(null); }}>
              {confirming ? `Show to ${client?.name}` : "Remove from portal"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** On a project's Deliverables tab: its prototypes first, or nothing when it has none. */
export function ProjectPrototypes({ companyId, projectId }: { companyId: string; projectId: string }) {
  const params = { organisationId: undefined, projectId };
  const query = useQuery({
    queryKey: queryKeys.prototypes.list(companyId, params),
    queryFn: () => prototypesApi.list(companyId, params),
  });
  if (!query.data?.prototypes.length) return null;
  return (
    <section aria-labelledby="project-prototypes" className="space-y-3">
      <h2 id="project-prototypes" className="text-sm font-semibold">Prototypes</h2>
      <PrototypeList companyId={companyId} projectId={projectId} />
    </section>
  );
}

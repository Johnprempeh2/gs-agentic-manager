import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Plus, Star } from "lucide-react";
import {
  ORGANISATION_STATUSES,
  ORGANISATION_STATUS_LABELS,
  type Organisation,
  type OrganisationContact,
  type OrganisationListItem,
  type OrganisationStatus,
} from "@greatstone/shared";
import { accessApi } from "@/api/access";
import { organisationsApi } from "@/api/organisations";
import { EmptyState } from "@/components/EmptyState";
import { HubspotImport } from "@/components/HubspotImport";
import { PipedriveImport } from "@/components/PipedriveImport";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useIsPhone } from "@/hooks/useIsPhone";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";

export const ORGANISATION_STATUS_BADGE: Record<OrganisationStatus, "default" | "secondary" | "outline"> = {
  target: "outline",
  prospect: "secondary",
  client: "default",
  former: "outline",
};

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function useDebounced<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function keyContactText(organisation: OrganisationListItem) {
  if (organisation.keyContacts.length === 0) return "No key contact";
  return organisation.keyContacts
    .map((contact) => (contact.role ? `${contact.name} (${contact.role})` : contact.name))
    .join(", ");
}

/**
 * Organisations (GRE-1477): every company the user works with, separate from
 * the pipeline board. Search, filter by status, add and edit. Each name opens
 * the company page (GRE-1480). The server
 * checks who may change records; a refusal shows in the dialog.
 */
export function Organisations() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const isPhone = useIsPhone();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<OrganisationStatus | "">("");
  const [editing, setEditing] = useState<OrganisationListItem | "new" | null>(null);
  const q = useDebounced(search, 250);

  useEffect(() => {
    setBreadcrumbs([{ label: "Organisations" }]);
  }, [setBreadcrumbs]);

  const query = useQuery({
    queryKey: queryKeys.organisations.list(selectedCompanyId ?? "", { q, status }),
    queryFn: () => organisationsApi.list(selectedCompanyId!, { q, status }),
    enabled: Boolean(selectedCompanyId),
  });
  const rows = query.data ?? [];
  const filtered = Boolean(q.trim() || status);

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">Organisations</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Every company you work with: targets, prospects, clients and former clients.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {selectedCompanyId ? <PipedriveImport companyId={selectedCompanyId} /> : null}
          {selectedCompanyId ? <HubspotImport companyId={selectedCompanyId} /> : null}
          <Button onClick={() => setEditing("new")}>
            <Plus />
            Add organisation
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          aria-label="Search organisations"
          placeholder="Search name, industry, country or contact"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="sm:w-80"
        />
        <NativeSelect
          aria-label="Filter by status"
          value={status}
          onChange={(event) => setStatus(event.target.value as OrganisationStatus | "")}
          className="sm:w-48"
        >
          <option value="">All statuses</option>
          {ORGANISATION_STATUSES.map((value) => (
            <option key={value} value={value}>{ORGANISATION_STATUS_LABELS[value]}</option>
          ))}
        </NativeSelect>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading organisations…</p>
      ) : query.error ? (
        <p className="text-sm text-destructive">Could not load organisations. {errorText(query.error)}</p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Building2}
          message={filtered ? "No organisations match this search." : "No organisations yet."}
          description={filtered ? undefined : "Add the companies you work with, or import them from your CRM later."}
        />
      ) : isPhone ? (
        <ul className="space-y-3" aria-label="Organisations">
          {rows.map((organisation) => (
            <li key={organisation.id}>
              <Link
                to={`/organisations/${organisation.id}`}
                className="block w-full rounded-lg border border-border px-3 py-2 text-left hover:bg-accent/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-medium">{organisation.name}</span>
                  <Badge variant={ORGANISATION_STATUS_BADGE[organisation.status]}>{ORGANISATION_STATUS_LABELS[organisation.status]}</Badge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {[organisation.industry, organisation.country, organisation.countryOwner].filter(Boolean).join(" · ") || "No details yet"}
                </div>
                <div className="mt-1 truncate text-xs">{keyContactText(organisation)}</div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm" aria-label="Organisations">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Industry</th>
                <th className="px-3 py-2 font-medium">Country</th>
                <th className="px-3 py-2 font-medium">Country owner</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Key contacts</th>
                <th className="px-3 py-2 font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((organisation) => (
                <tr key={organisation.id} className="border-t border-border hover:bg-accent/40">
                  <td className="px-3 py-2">
                    <Link to={`/organisations/${organisation.id}`} className="font-medium hover:underline">
                      {organisation.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{organisation.industry ?? "Not set"}</td>
                  <td className="px-3 py-2">{organisation.country ?? "Not set"}</td>
                  <td className="px-3 py-2">{organisation.countryOwner ?? "Not set"}</td>
                  <td className="px-3 py-2">
                    <Badge variant={ORGANISATION_STATUS_BADGE[organisation.status]}>{ORGANISATION_STATUS_LABELS[organisation.status]}</Badge>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{keyContactText(organisation)}</td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      aria-label={`Edit ${organisation.name}`}
                      onClick={() => setEditing(organisation)}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing !== null && selectedCompanyId ? (
          <OrganisationDialogContent
            key={editing === "new" ? "new" : editing.id}
            companyId={selectedCompanyId}
            organisation={editing === "new" ? null : editing}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

export function OrganisationDialogContent({
  companyId,
  organisation,
  onDone,
}: {
  companyId: string;
  organisation: Organisation | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: organisation?.name ?? "",
    website: organisation?.website ?? "",
    industry: organisation?.industry ?? "",
    country: organisation?.country ?? "",
    countryOwner: organisation?.countryOwner ?? "",
    countryOwnerUserId: organisation?.countryOwnerUserId ?? "",
    status: organisation?.status ?? ("target" as OrganisationStatus),
    notes: organisation?.notes ?? "",
  });
  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.organisations.all(companyId) });

  // The country owner is picked from the company's members (Ben, 12 Oct);
  // "Someone else" keeps a typed name for owners who are not on GSAM.
  const members = useQuery({
    queryKey: queryKeys.access.companyMembers(companyId),
    queryFn: () => accessApi.listMembers(companyId),
  });
  const people = (members.data?.members ?? [])
    .filter((member) => member.status === "active" && member.user)
    .map((member) => ({ id: member.principalId, name: member.user?.name || member.user?.email || "Unnamed member" }));
  const [ownerIsOther, setOwnerIsOther] = useState(
    Boolean(organisation?.countryOwner && !organisation?.countryOwnerUserId),
  );
  const payload = () => {
    const { countryOwnerUserId, ...rest } = form;
    const ownerId = ownerIsOther ? null : countryOwnerUserId || null;
    const changed = ownerId !== (organisation?.countryOwnerUserId ?? null);
    return {
      ...rest,
      countryOwner: ownerIsOther ? rest.countryOwner : ownerId ? rest.countryOwner : "",
      ...(changed || !organisation ? { countryOwnerUserId: ownerId } : {}),
    };
  };

  const save = useMutation({
    mutationFn: () =>
      organisation
        ? organisationsApi.update(companyId, organisation.id, payload())
        : organisationsApi.create(companyId, payload()),
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });
  const archive = useMutation({
    mutationFn: () => organisationsApi.archive(companyId, organisation!.id),
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) return;
    save.mutate();
  };

  const field = (key: "website" | "industry" | "country", label: string) => (
    <div className="space-y-1">
      <Label htmlFor={`organisation-${key}`}>{label}</Label>
      <Input id={`organisation-${key}`} value={form[key]} onChange={(event) => set(key)(event.target.value)} />
    </div>
  );

  return (
    <DialogContent className="max-h-(--sz-90vh) overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{organisation ? "Edit organisation" : "Add organisation"}</DialogTitle>
        <DialogDescription>Only the name is required.</DialogDescription>
      </DialogHeader>
      <form className="space-y-3" onSubmit={submit}>
        <div className="space-y-1">
          <Label htmlFor="organisation-name">Name</Label>
          <Input id="organisation-name" value={form.name} onChange={(event) => set("name")(event.target.value)} required />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {field("industry", "Industry")}
          {field("website", "Website")}
          {field("country", "Country")}
          <div className="space-y-1">
            <Label htmlFor="organisation-countryOwnerUserId">Country owner</Label>
            <NativeSelect
              id="organisation-countryOwnerUserId"
              value={ownerIsOther ? "__other" : form.countryOwnerUserId}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "__other") {
                  setOwnerIsOther(true);
                  setForm((current) => ({ ...current, countryOwnerUserId: "" }));
                  return;
                }
                setOwnerIsOther(false);
                const person = people.find((entry) => entry.id === value);
                setForm((current) => ({ ...current, countryOwnerUserId: value, countryOwner: person?.name ?? "" }));
              }}
            >
              <option value="">Nobody yet</option>
              {form.countryOwnerUserId && !people.some((entry) => entry.id === form.countryOwnerUserId) ? (
                <option value={form.countryOwnerUserId}>{form.countryOwner || "Current owner"}</option>
              ) : null}
              {people.map((person) => (
                <option key={person.id} value={person.id}>{person.name}</option>
              ))}
              <option value="__other">Someone else (type a name)</option>
            </NativeSelect>
            {ownerIsOther ? (
              <Input
                aria-label="Country owner name"
                value={form.countryOwner}
                onChange={(event) => set("countryOwner")(event.target.value)}
                placeholder="Name"
              />
            ) : null}
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="organisation-status">Status</Label>
          <NativeSelect
            id="organisation-status"
            value={form.status}
            onChange={(event) => set("status")(event.target.value)}
          >
            {ORGANISATION_STATUSES.map((value) => (
              <option key={value} value={value}>{ORGANISATION_STATUS_LABELS[value]}</option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1">
          <Label htmlFor="organisation-notes">Notes</Label>
          <Textarea id="organisation-notes" rows={3} value={form.notes} onChange={(event) => set("notes")(event.target.value)} />
        </div>
        {save.error ? <p className="text-sm text-destructive" role="alert">{errorText(save.error)}</p> : null}
        {archive.error ? <p className="text-sm text-destructive" role="alert">{errorText(archive.error)}</p> : null}
        <DialogFooter className="gap-2">
          {organisation ? (
            <Button
              type="button"
              variant="outline"
              className="sm:mr-auto"
              disabled={archive.isPending}
              onClick={() => archive.mutate()}
            >
              Archive
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
          <Button type="submit" disabled={save.isPending || !form.name.trim()}>
            {save.isPending ? "Saving…" : organisation ? "Save" : "Add organisation"}
          </Button>
        </DialogFooter>
      </form>
      {organisation ? <ContactsSection companyId={companyId} organisationId={organisation.id} /> : null}
    </DialogContent>
  );
}

const EMPTY_CONTACT = { name: "", role: "", email: "", phone: "", isKeyContact: false };

/** The people at an organisation: mark key contacts, add, archive. */
function ContactsSection({ companyId, organisationId }: { companyId: string; organisationId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(EMPTY_CONTACT);
  const detail = useQuery({
    queryKey: queryKeys.organisations.detail(companyId, organisationId),
    queryFn: () => organisationsApi.get(companyId, organisationId),
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.organisations.all(companyId) });
  const add = useMutation({
    mutationFn: () => organisationsApi.createContact(companyId, organisationId, draft),
    onSuccess: async () => {
      setDraft(EMPTY_CONTACT);
      await invalidate();
    },
  });
  const update = useMutation({
    mutationFn: ({ contact, isKeyContact }: { contact: OrganisationContact; isKeyContact: boolean }) =>
      organisationsApi.updateContact(companyId, organisationId, contact.id, { isKeyContact }),
    onSuccess: invalidate,
  });
  const archive = useMutation({
    mutationFn: (contact: OrganisationContact) => organisationsApi.archiveContact(companyId, organisationId, contact.id),
    onSuccess: invalidate,
  });
  const contacts = (detail.data?.contacts ?? []).filter((contact) => !contact.archivedAt);
  const error = add.error ?? update.error ?? archive.error;

  return (
    <section className="space-y-2 border-t border-border pt-3" aria-label="Contacts">
      <h3 className="text-sm font-medium">Contacts</h3>
      {detail.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading contacts…</p>
      ) : contacts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No contacts yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {contacts.map((contact) => (
            <li key={contact.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              {contact.isKeyContact ? <Star className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Key contact" /> : null}
              <div className="min-w-0 flex-1">
                <div className="truncate">{contact.role ? `${contact.name} (${contact.role})` : contact.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {[contact.email, contact.phone].filter(Boolean).join(" · ")}
                </div>
              </div>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={update.isPending}
                onClick={() => update.mutate({ contact, isKeyContact: !contact.isKeyContact })}
              >
                {contact.isKeyContact ? "Unmark key" : "Mark key"}
              </Button>
              <Button type="button" size="xs" variant="ghost" disabled={archive.isPending} onClick={() => archive.mutate(contact)}>
                Archive
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-2 sm:grid-cols-2"
        aria-label="Add contact"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.name.trim()) add.mutate();
        }}
      >
        <Input aria-label="Contact name" placeholder="Name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <Input aria-label="Contact role" placeholder="Role" value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })} />
        <Input aria-label="Contact email" placeholder="Email" type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} />
        <Input aria-label="Contact phone" placeholder="Phone" value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.isKeyContact}
            onCheckedChange={(checked) => setDraft({ ...draft, isKeyContact: checked === true })}
          />
          Key contact
        </label>
        <Button type="submit" variant="outline" disabled={add.isPending || !draft.name.trim()}>
          Add contact
        </Button>
      </form>
      {error ? <p className="text-sm text-destructive" role="alert">{errorText(error)}</p> : null}
    </section>
  );
}

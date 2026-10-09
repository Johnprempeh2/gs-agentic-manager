import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Pencil, Phone, Plus, X } from "lucide-react";
import {
  pipelinesApi,
  type PipelineCaseContact,
  type PipelineCaseContactInput,
} from "../api/pipelines";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const EMPTY_DRAFT: PipelineCaseContactInput = { name: "", role: "", phone: "", email: "" };

function readText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Contacts written into the case record before the contact list existed
 * (for example `fields.contacts` from a batch ingest). Shown as an offer to
 * copy them into the list, never copied without a click.
 */
export function readRecordContacts(fields: Record<string, unknown> | null | undefined): PipelineCaseContactInput[] {
  const raw = fields?.contacts;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const name = readText(record.name);
    if (!name) return [];
    return [{ name, role: readText(record.role), phone: readText(record.phone), email: readText(record.email) }];
  });
}

function ContactForm({
  initial,
  submitLabel,
  pending,
  onSubmit,
  onCancel,
}: {
  initial: PipelineCaseContactInput;
  submitLabel: string;
  pending: boolean;
  onSubmit: (input: PipelineCaseContactInput) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<PipelineCaseContactInput>(initial);
  const set = (key: keyof PipelineCaseContactInput) => (event: { target: { value: string } }) =>
    setDraft((current) => ({ ...current, [key]: event.target.value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim()) return;
    onSubmit({
      name: draft.name.trim(),
      role: draft.role?.trim() ?? "",
      phone: draft.phone?.trim() ?? "",
      email: draft.email?.trim() ?? "",
    });
  };
  return (
    <form className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-2" onSubmit={submit}>
      <Input aria-label="Name" placeholder="Name" value={draft.name} onChange={set("name")} required autoFocus />
      <Input aria-label="Role" placeholder="Role" value={draft.role ?? ""} onChange={set("role")} />
      <Input aria-label="Phone" placeholder="Phone" type="tel" value={draft.phone ?? ""} onChange={set("phone")} />
      <Input aria-label="Email" placeholder="Email" type="email" value={draft.email ?? ""} onChange={set("email")} />
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={pending || !draft.name.trim()}>
          {pending ? "Saving..." : submitLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ContactRow({
  contact,
  busy,
  onEdit,
  onRemove,
}: {
  contact: PipelineCaseContact;
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-start gap-2 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{contact.name}</p>
        {contact.role ? <p className="text-xs text-muted-foreground">{contact.role}</p> : null}
        {contact.phone || contact.email ? (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {contact.phone ? (
              <a href={`tel:${contact.phone.replace(/\s+/g, "")}`} className="inline-flex items-center gap-1 text-foreground hover:underline">
                <Phone className="h-3 w-3 text-muted-foreground" />
                {contact.phone}
              </a>
            ) : null}
            {contact.email ? (
              <a href={`mailto:${contact.email}`} className="inline-flex min-w-0 items-center gap-1 text-foreground hover:underline [overflow-wrap:anywhere]">
                <Mail className="h-3 w-3 shrink-0 text-muted-foreground" />
                {contact.email}
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        aria-label={`Edit ${contact.name}`}
        disabled={busy}
        onClick={onEdit}
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        aria-label={`Remove ${contact.name}`}
        disabled={busy}
        onClick={onRemove}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

/** The people at a client: name, role, phone and email (GRE-1048). */
export function PipelineCaseContacts({
  caseId,
  recordFields,
}: {
  caseId: string;
  recordFields?: Record<string, unknown> | null;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const contacts = useQuery({
    queryKey: queryKeys.pipelines.caseContacts(caseId),
    queryFn: () => pipelinesApi.listCaseContacts(caseId),
  });
  const recordContacts = useMemo(() => readRecordContacts(recordFields), [recordFields]);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseContacts(caseId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseEvents(caseId) }),
    ]);

  const createContact = useMutation({
    mutationFn: (input: PipelineCaseContactInput) => pipelinesApi.createCaseContact(caseId, input),
    onSuccess: async () => {
      setAdding(false);
      await invalidate();
    },
    onError: () => pushToast({ title: "Could not add the contact", body: "Check the email address and try again.", tone: "error" }),
  });
  const updateContact = useMutation({
    mutationFn: ({ contactId, input }: { contactId: string; input: PipelineCaseContactInput }) =>
      pipelinesApi.updateCaseContact(caseId, contactId, input),
    onSuccess: async () => {
      setEditingId(null);
      await invalidate();
    },
    onError: () => pushToast({ title: "Could not save the contact", body: "Check the email address and try again.", tone: "error" }),
  });
  const deleteContact = useMutation({
    mutationFn: (contactId: string) => pipelinesApi.deleteCaseContact(caseId, contactId),
    onSuccess: invalidate,
    onError: () => pushToast({ title: "Could not remove the contact", tone: "error" }),
  });
  const copyRecordContacts = useMutation({
    mutationFn: async () => {
      for (const input of recordContacts) await pipelinesApi.createCaseContact(caseId, input);
    },
    onSettled: invalidate,
    onError: () => pushToast({ title: "Could not copy every contact", body: "Check the list and add any missing ones.", tone: "error" }),
  });

  if (contacts.isLoading) {
    return <p className="py-3 text-sm text-muted-foreground">Loading contacts...</p>;
  }
  if (contacts.error) {
    return <p className="py-3 text-sm text-destructive">Could not load contacts.</p>;
  }

  const rows = contacts.data ?? [];
  const busy = createContact.isPending || updateContact.isPending || deleteContact.isPending || copyRecordContacts.isPending;

  return (
    <div className="space-y-3 py-3">
      {rows.length > 0 ? (
        <ul className="divide-y divide-border">
          {rows.map((contact) =>
            editingId === contact.id ? (
              <li key={contact.id} className="py-2">
                <ContactForm
                  initial={{
                    name: contact.name,
                    role: contact.role ?? "",
                    phone: contact.phone ?? "",
                    email: contact.email ?? "",
                  }}
                  submitLabel="Save"
                  pending={updateContact.isPending}
                  onSubmit={(input) => updateContact.mutate({ contactId: contact.id, input })}
                  onCancel={() => setEditingId(null)}
                />
              </li>
            ) : (
              <ContactRow
                key={contact.id}
                contact={contact}
                busy={busy}
                onEdit={() => {
                  setAdding(false);
                  setEditingId(contact.id);
                }}
                onRemove={() => deleteContact.mutate(contact.id)}
              />
            ),
          )}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No contacts yet.</p>
      )}

      {rows.length === 0 && recordContacts.length > 0 ? (
        <div className="rounded-md border border-dashed border-border p-3 text-sm">
          <p className="text-muted-foreground">
            The case record names {recordContacts.length} {recordContacts.length === 1 ? "contact" : "contacts"}:{" "}
            {recordContacts.map((contact) => contact.name).join(", ")}.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            disabled={busy}
            onClick={() => copyRecordContacts.mutate()}
          >
            {copyRecordContacts.isPending ? "Copying..." : "Copy into the contact list"}
          </Button>
        </div>
      ) : null}

      {adding ? (
        <ContactForm
          initial={EMPTY_DRAFT}
          submitLabel="Add contact"
          pending={createContact.isPending}
          onSubmit={(input) => createContact.mutate(input)}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setEditingId(null);
            setAdding(true);
          }}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add contact
        </Button>
      )}
    </div>
  );
}

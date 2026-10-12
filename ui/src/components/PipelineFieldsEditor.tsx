import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ListPlus, Pencil, RotateCcw } from "lucide-react";
import {
  PIPELINE_FIELD_KEY_PATTERN,
  PIPELINE_FIELD_TYPES,
  PIPELINE_FIELD_TYPES_WITH_OPTIONS,
} from "@greatstone/shared";
import {
  pipelinesApi,
  type PipelineFieldDefinition,
  type PipelineFieldInput,
  type PipelineFieldType,
} from "../api/pipelines";
import { queryKeys } from "../lib/queryKeys";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Textarea } from "./ui/textarea";

export const PIPELINE_FIELD_TYPE_LABELS: Record<PipelineFieldType, string> = {
  text: "Short text",
  long_text: "Long text",
  number: "Number",
  boolean: "Yes / no",
  date: "Date",
  select: "One choice",
  multi_select: "Several choices",
  email: "Email",
  phone: "Phone",
  url: "Web address",
};

/** "Deal value (GBP)" -> "dealValueGbp". Matches the server's key rule. */
export function fieldKeyFromLabel(label: string) {
  const words = label
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // Keys start with a letter, so leading numbers are dropped.
  while (words.length > 0 && /^[0-9]/.test(words[0]!)) {
    words[0] = words[0]!.replace(/^[0-9]+/, "");
    if (!words[0]) words.shift();
  }
  const key = words
    .map((word, index) => {
      const lower = word.toLowerCase();
      return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
  return key.slice(0, 64);
}

export function parseFieldOptions(text: string) {
  const seen = new Set<string>();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || seen.has(line)) return false;
      seen.add(line);
      return true;
    });
}

interface FieldDraft {
  label: string;
  key: string;
  keyTouched: boolean;
  type: PipelineFieldType;
  required: boolean;
  optionsText: string;
  description: string;
}

function draftFor(field: PipelineFieldDefinition | null): FieldDraft {
  if (!field) {
    return { label: "", key: "", keyTouched: false, type: "text", required: false, optionsText: "", description: "" };
  }
  return {
    label: field.label,
    key: field.key,
    keyTouched: true,
    type: field.type,
    required: field.required,
    optionsText: field.options.join("\n"),
    description: field.description ?? "",
  };
}

function FieldForm({
  field,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  field: PipelineFieldDefinition | null;
  pending: boolean;
  error: string | null;
  onSubmit: (input: PipelineFieldInput) => void;
  onCancel: () => void;
}) {
  const editing = field !== null;
  const [draft, setDraft] = useState<FieldDraft>(() => draftFor(field));
  const needsOptions = PIPELINE_FIELD_TYPES_WITH_OPTIONS.includes(draft.type);
  const options = parseFieldOptions(draft.optionsText);
  const keyValid = PIPELINE_FIELD_KEY_PATTERN.test(draft.key);
  const canSave = draft.label.trim().length > 0 && keyValid && (!needsOptions || options.length > 0);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    onSubmit({
      key: draft.key,
      label: draft.label.trim(),
      type: draft.type,
      required: draft.required,
      options: needsOptions ? options : [],
      description: draft.description.trim() || null,
    });
  };

  return (
    <form className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2" onSubmit={submit}>
      <label className="space-y-1 text-sm font-medium">
        <span>Name</span>
        <Input
          aria-label="Field name"
          value={draft.label}
          autoFocus
          required
          onChange={(event) => {
            const label = event.target.value;
            setDraft((current) => ({
              ...current,
              label,
              key: current.keyTouched ? current.key : fieldKeyFromLabel(label),
            }));
          }}
        />
      </label>
      <label className="space-y-1 text-sm font-medium">
        <span>Key</span>
        <Input
          aria-label="Field key"
          value={draft.key}
          disabled={editing}
          aria-invalid={draft.key.length > 0 && !keyValid}
          onChange={(event) => setDraft((current) => ({ ...current, key: event.target.value, keyTouched: true }))}
        />
        <span className="block text-xs font-normal text-muted-foreground">
          {editing ? "The key cannot change." : "Letters, numbers and _. Used by automations and CRM sync."}
        </span>
      </label>
      <label className="space-y-1 text-sm font-medium">
        <span>Type</span>
        <NativeSelect
          aria-label="Field type"
          value={draft.type}
          disabled={editing}
          onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as PipelineFieldType }))}
        >
          {PIPELINE_FIELD_TYPES.map((type) => (
            <option key={type} value={type}>{PIPELINE_FIELD_TYPE_LABELS[type]}</option>
          ))}
        </NativeSelect>
      </label>
      <label className="flex items-center gap-2 self-end pb-2 text-sm font-medium">
        <input
          type="checkbox"
          aria-label="Required"
          checked={draft.required}
          onChange={(event) => setDraft((current) => ({ ...current, required: event.target.checked }))}
        />
        <span>Required on new items</span>
      </label>
      {needsOptions ? (
        <label className="space-y-1 text-sm font-medium sm:col-span-2">
          <span>Choices (one per line)</span>
          <Textarea
            aria-label="Choices"
            rows={4}
            value={draft.optionsText}
            onChange={(event) => setDraft((current) => ({ ...current, optionsText: event.target.value }))}
          />
        </label>
      ) : null}
      <label className="space-y-1 text-sm font-medium sm:col-span-2">
        <span>Help text (optional)</span>
        <Input
          aria-label="Help text"
          value={draft.description}
          onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
        />
      </label>
      {error ? <p className="text-sm text-destructive sm:col-span-2">{error}</p> : null}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={pending || !canSave}>
          {pending ? "Saving..." : editing ? "Save field" : "Add field"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function FieldRow({
  field,
  busy,
  onEdit,
  onToggleArchived,
}: {
  field: PipelineFieldDefinition;
  busy: boolean;
  onEdit?: () => void;
  onToggleArchived?: () => void;
}) {
  const archived = field.archivedAt !== null;
  return (
    <li className="flex items-start gap-2 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{field.label}</span>
          <Badge variant="secondary" className="font-normal">{PIPELINE_FIELD_TYPE_LABELS[field.type]}</Badge>
          {field.required ? <Badge variant="outline" className="font-normal">Required</Badge> : null}
        </p>
        <p className="mt-0.5 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{field.key}</p>
        {field.options.length > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{field.options.join(", ")}</p>
        ) : null}
      </div>
      {onEdit ? (
        <button
          type="button"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          aria-label={`Edit ${field.label}`}
          disabled={busy}
          onClick={onEdit}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      ) : null}
      {onToggleArchived ? (
        <button
          type="button"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          aria-label={archived ? `Restore ${field.label}` : `Archive ${field.label}`}
          title={archived ? "Restore" : "Archive. Values on items are kept."}
          disabled={busy}
          onClick={onToggleArchived}
        >
          {archived ? <RotateCcw className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
        </button>
      ) : null}
    </li>
  );
}

/**
 * Typed fields every item in a pipeline carries (GRE-1075). Without
 * `canEdit` the list is read-only; the server still refuses writes.
 */
export function PipelineFieldsEditor({ pipelineId, canEdit }: { pipelineId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<PipelineFieldDefinition | "new" | null>(null);
  const fieldsQuery = useQuery({
    queryKey: queryKeys.pipelines.fields(pipelineId),
    queryFn: () => pipelinesApi.listFields(pipelineId, { includeArchived: true }),
  });

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.fields(pipelineId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) }),
    ]);
  };

  const saveField = useMutation({
    mutationFn: async (input: PipelineFieldInput) => {
      if (editing && editing !== "new") {
        const { key: _key, type: _type, ...patch } = input;
        return pipelinesApi.updateField(pipelineId, editing.id, patch);
      }
      return pipelinesApi.createField(pipelineId, input);
    },
    onSuccess: async () => {
      setEditing(null);
      await invalidate();
    },
  });

  const toggleArchived = useMutation({
    mutationFn: (field: PipelineFieldDefinition) =>
      pipelinesApi.updateField(pipelineId, field.id, { archived: field.archivedAt === null }),
    onSuccess: invalidate,
  });

  const fields = fieldsQuery.data ?? [];
  const active = fields.filter((field) => field.archivedAt === null);
  const archived = fields.filter((field) => field.archivedAt !== null);
  const busy = saveField.isPending || toggleArchived.isPending;

  return (
    <section className="space-y-3 border-t border-border pt-5" aria-labelledby="pipeline-fields-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="pipeline-fields-heading" className="text-base font-semibold">Fields</h2>
          <p className="text-sm text-muted-foreground">
            Details every item in this pipeline carries. Values are checked when an item is added or edited.
          </p>
        </div>
        {canEdit && editing === null ? (
          <Button type="button" size="sm" variant="outline" onClick={() => { saveField.reset(); setEditing("new"); }}>
            <ListPlus className="h-4 w-4" />
            Add field
          </Button>
        ) : null}
      </div>

      {canEdit && editing !== null ? (
        <FieldForm
          key={editing === "new" ? "new" : editing.id}
          field={editing === "new" ? null : editing}
          pending={saveField.isPending}
          error={saveField.error ? saveField.error.message : null}
          onSubmit={(input) => saveField.mutate(input)}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {fieldsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading fields...</p>
      ) : fieldsQuery.error ? (
        <p className="text-sm text-destructive">Could not load fields: {fieldsQuery.error.message}</p>
      ) : active.length === 0 && editing === null ? (
        <p className="text-sm text-muted-foreground">
          {canEdit ? "No fields yet. Add one to give every item the same details." : "No fields yet."}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {active.map((field) => (
            <FieldRow
              key={field.id}
              field={field}
              busy={busy}
              onEdit={canEdit ? () => { saveField.reset(); setEditing(field); } : undefined}
              onToggleArchived={canEdit ? () => toggleArchived.mutate(field) : undefined}
            />
          ))}
        </ul>
      )}
      {toggleArchived.error ? <p className="text-sm text-destructive">{toggleArchived.error.message}</p> : null}

      {archived.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Archived ({archived.length})</summary>
          <ul className="divide-y divide-border">
            {archived.map((field) => (
              <FieldRow
                key={field.id}
                field={field}
                busy={busy}
                onToggleArchived={canEdit ? () => toggleArchived.mutate(field) : undefined}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

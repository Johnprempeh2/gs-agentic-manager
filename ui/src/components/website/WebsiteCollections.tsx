import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  websiteCollectionDefinition,
  websiteCollectionFieldSchema,
  websiteCollectionManifest,
  type WebsiteEntryDetail,
  type WebsiteProperty,
} from "@greatstone/shared";
import { websiteModuleApi } from "../../api/website";
import { formatDateTime } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ErrorState, errorStateMessage } from "../ErrorState";
import { useWebsiteSite } from "./WebsiteSiteConnection";
import { useCanManageWebsite } from "./WebsiteSetup";

type FieldSchema = {
  $ref?: string;
  type?: string | string[];
  enum?: (string | number)[];
  properties?: Record<string, FieldSchema>;
  required?: string[];
  items?: FieldSchema;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  minItems?: number;
};
type Value = unknown;

const COLLECTIONS = [
  { key: "product", label: "Products", singular: "product" },
  { key: "category", label: "Categories", singular: "category" },
  { key: "public-person", label: "Team", singular: "team member" },
  { key: "redirect", label: "Redirects", singular: "redirect" },
  { key: "form", label: "Forms", singular: "form" },
  { key: "vendor", label: "Vendors", singular: "vendor" },
] as const;

function resolve(schema: FieldSchema): FieldSchema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.split("/").at(-1) ?? "";
  return websiteCollectionFieldSchema.$defs[name as keyof typeof websiteCollectionFieldSchema.$defs] as FieldSchema;
}

function blank(schema: FieldSchema): Value {
  const field = resolve(schema);
  if (field.enum) return field.enum[0];
  if (field.type === "object") {
    return Object.fromEntries((field.required ?? []).map((key) => [key, blank(field.properties?.[key] ?? {})]));
  }
  if (field.type === "array") return Array.from({ length: field.minItems ?? 0 }, () => blank(field.items ?? {}));
  if (Array.isArray(field.type) && field.type.includes("null")) return null;
  if (field.type === "boolean") return false;
  if (field.type === "integer" || field.type === "number") return field.minimum ?? 0;
  return "";
}

function humanise(key: string) {
  return key.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (char) => char.toUpperCase());
}

function SchemaField({ schema, value, label, path, onChange }: {
  schema: FieldSchema;
  value: Value;
  label: string;
  path: string;
  onChange: (value: Value) => void;
}) {
  const field = resolve(schema);
  if (field.type === "object") {
    const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Value> : {};
    return (
      <fieldset className="space-y-3 border-l pl-4">
        <legend className="text-sm font-medium">{label}</legend>
        {Object.entries(field.properties ?? {}).map(([key, child]) => {
          const required = field.required?.includes(key) ?? false;
          const present = Object.hasOwn(object, key);
          return (
            <div key={key} className="space-y-1">
              {present ? (
                <SchemaField schema={child} value={object[key]} label={humanise(key)} path={`${path}-${key}`}
                  onChange={(next) => onChange({ ...object, [key]: next })} />
              ) : (
                <Button type="button" size="xs" variant="ghost" onClick={() => onChange({ ...object, [key]: blank(child) })}>
                  Add {humanise(key).toLowerCase()}
                </Button>
              )}
              {present && !required ? <Button type="button" size="xs" variant="ghost" onClick={() => {
                const next = { ...object }; delete next[key]; onChange(next);
              }}>Remove {humanise(key).toLowerCase()}</Button> : null}
            </div>
          );
        })}
      </fieldset>
    );
  }
  if (field.type === "array") {
    const items = Array.isArray(value) ? value : [];
    return (
      <fieldset className="space-y-3 border-l pl-4">
        <legend className="text-sm font-medium">{label}</legend>
        {items.map((item, index) => (
          <div className="space-y-2 border-b pb-3" key={index}>
            <SchemaField schema={field.items ?? {}} value={item} label={`${label} ${index + 1}`} path={`${path}-${index}`}
              onChange={(next) => onChange(items.map((old, at) => at === index ? next : old))} />
            {items.length > (field.minItems ?? 0) ? <Button type="button" size="xs" variant="ghost" onClick={() => onChange(items.filter((_, at) => at !== index))}>Remove</Button> : null}
          </div>
        ))}
        <Button type="button" size="xs" variant="outline" onClick={() => onChange([...items, blank(field.items ?? {})])}>Add {label.toLowerCase()}</Button>
      </fieldset>
    );
  }
  if (field.type === "boolean") return <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
  if (field.enum) return <label className="block space-y-1 text-sm"><span className="font-medium">{label}</span><NativeSelect id={path} value={String(value ?? field.enum[0])} onChange={(event) => onChange(typeof field.enum?.[0] === "number" ? Number(event.target.value) : event.target.value)}>{field.enum.map((option) => <option key={option} value={option}>{option}</option>)}</NativeSelect></label>;
  const isNumber = field.type === "integer" || field.type === "number" || (Array.isArray(field.type) && field.type.includes("integer"));
  const nullable = Array.isArray(field.type) && field.type.includes("null");
  const common = { id: path, value: value == null ? "" : String(value), required: field.minLength !== undefined && field.minLength > 0, minLength: field.minLength, maxLength: field.maxLength, pattern: field.pattern };
  return <label className="block space-y-1 text-sm"><span className="font-medium">{label}</span>
    {field.maxLength && field.maxLength > 500 && !isNumber ? <Textarea {...common} onChange={(event) => onChange(event.target.value)} /> :
      <Input {...common} type={isNumber ? "number" : "text"} min={field.minimum} step={isNumber ? 1 : undefined}
        onChange={(event) => onChange(isNumber ? (event.target.value === "" && nullable ? null : Number(event.target.value)) : (event.target.value === "" && nullable ? null : event.target.value))} />}
  </label>;
}

function EntryEditor({ companyId, siteId, collection, entryId, onClose }: {
  companyId: string; siteId: string; collection: string; entryId: string | null; onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const definition = websiteCollectionDefinition(collection)!;
  const detail = useQuery({ queryKey: ["website-entry", companyId, siteId, entryId], queryFn: () => websiteModuleApi.entry(companyId, siteId, entryId!), enabled: !!entryId });
  const revisions = useQuery({ queryKey: ["website-entry-revisions", companyId, siteId, entryId], queryFn: () => websiteModuleApi.entryRevisions(companyId, siteId, entryId!), enabled: !!entryId });
  const { canManage } = useCanManageWebsite(companyId);
  const [entryKey, setEntryKey] = useState("");
  const [fields, setFields] = useState<Value>(() => blank(definition.definition as FieldSchema));
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!detail.data) return;
    setEntryKey(detail.data.entryKey);
    setFields(detail.data.content);
  }, [detail.data]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["website-entry", companyId, siteId] });
    void queryClient.invalidateQueries({ queryKey: ["website-entries", companyId, siteId] });
    void queryClient.invalidateQueries({ queryKey: ["website-entry-revisions", companyId, siteId] });
  };
  const save = useMutation({
    mutationFn: async () => {
      if (!entryId) return websiteModuleApi.createEntry(companyId, siteId, { collection, entryKey: entryKey.trim(), content: fields });
      const result = await websiteModuleApi.saveEntry(companyId, siteId, entryId, { baseRevisionId: detail.data!.latestRevisionId!, content: fields });
      if (result.state !== "saved") throw new Error(result.message);
      if (entryKey.trim() !== detail.data?.entryKey) await websiteModuleApi.updateEntry(companyId, siteId, entryId, { entryKey: entryKey.trim() });
      return result;
    },
    onSuccess: () => { setMessage("Draft saved. It goes live after approval and the next Publish."); refresh(); if (entryId) void detail.refetch(); else onClose(); },
  });
  const changeStatus = useMutation({
    mutationFn: async (action: "review" | "approve" | "archive") => {
      if (!entryId) throw new Error("Save the draft first.");
      if (action === "approve") return websiteModuleApi.approveEntry(companyId, siteId, entryId);
      if (action === "archive") return websiteModuleApi.archiveEntry(companyId, siteId, entryId);
      return websiteModuleApi.submitEntry(companyId, siteId, entryId);
    },
    onSuccess: (_, action) => { setMessage(action === "review" ? "Sent for review." : action === "approve" ? "Approved. This change goes live with the next Publish." : "Archived. This change goes live with the next Publish."); refresh(); void detail.refetch(); if (action === "archive") onClose(); },
  });
  if (detail.error) return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  if (entryId && !detail.data) return <p className="text-sm text-muted-foreground">Loading entry</p>;
  const entry = detail.data as WebsiteEntryDetail | undefined;
  const dirty = !!entry && (entryKey.trim() !== entry.entryKey || JSON.stringify(fields) !== JSON.stringify(entry.content));
  const restore = async (revisionId: string) => {
    if (!entryId || !window.confirm("Restore this version? It becomes a new draft after you save. The live site does not change until the next Publish.")) return;
    try {
      const old = await websiteModuleApi.entryRevision(companyId, siteId, entryId, revisionId);
      setFields(old.content);
      setMessage(`Version ${old.revisionNumber} is loaded. Select Save draft to keep it as a new version.`);
    } catch (error) { setMessage(errorStateMessage(error)); }
  };
  return <section className="space-y-5" data-testid="website-entry-editor">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-lg font-semibold">{entry ? entry.entryKey : `New ${collection}`}</h3><p className="text-sm text-muted-foreground">Fields version {definition.fieldsVersion}. {entry?.status ?? "Draft"}. Changes go live with the next Publish.</p></div><Button variant="ghost" onClick={onClose}>Back to list</Button></div>
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <label className="block space-y-1 text-sm"><span className="font-medium">Entry key</span><Input value={entryKey} onChange={(event) => setEntryKey(event.target.value)} required maxLength={200} /></label>
      <SchemaField schema={definition.definition as FieldSchema} value={fields} label="Fields" path="website-entry-fields" onChange={setFields} />
      <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" className="ml-auto" disabled={save.isPending || !entryKey.trim()}>{save.isPending ? "Saving" : "Save draft"}</Button></div>
    </form>
    {entry ? <div className="flex flex-wrap gap-2">
      {entry.status === "draft" ? <Button variant="outline" onClick={() => changeStatus.mutate("review")} disabled={changeStatus.isPending || save.isPending || dirty}>Send for review</Button> : null}
      {entry.status === "review" && canManage ? <Button variant="outline" onClick={() => changeStatus.mutate("approve")} disabled={changeStatus.isPending || dirty}>Approve</Button> : null}
      <Button variant="ghost" onClick={() => { if (window.confirm(`Archive this ${collection}? It leaves the live site at the next Publish. History stays.`)) changeStatus.mutate("archive"); }} disabled={changeStatus.isPending}>Archive</Button>
    </div> : null}
    {message ? <p role="status" className="text-sm text-status-success">{message}</p> : null}
    {save.error || changeStatus.error ? <p role="alert" className="text-sm text-status-danger">{errorStateMessage(save.error ?? changeStatus.error)}</p> : null}
    {entry ? <section className="space-y-2"><h4 className="text-sm font-semibold">History</h4>{revisions.error ? <ErrorState error={revisions.error} onRetry={() => void revisions.refetch()} /> : revisions.data?.map((revision) => <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground" key={revision.id}><span>Version {revision.revisionNumber}, {formatDateTime(revision.createdAt)}{revision.changeSummary ? `: ${revision.changeSummary}` : ""}</span>{revision.id !== entry.latestRevisionId ? <Button type="button" size="xs" variant="ghost" onClick={() => void restore(revision.id)}>Restore</Button> : null}</div>)}</section> : null}
  </section>;
}

export function WebsiteCollectionsTab({ companyId, property }: { companyId: string; property: WebsiteProperty }) {
  const queryClient = useQueryClient();
  const { site, isLoading, error } = useWebsiteSite(companyId, property.id);
  const { canManage } = useCanManageWebsite(companyId);
  const [collection, setCollection] = useState<string>("product");
  const [entryId, setEntryId] = useState<string | null | undefined>(undefined);
  const entries = useQuery({ queryKey: ["website-entries", companyId, site?.id, collection], queryFn: () => websiteModuleApi.entries(companyId, site!.id, collection), enabled: !!site });
  const importDrafts = useMutation({
    mutationFn: () => websiteModuleApi.importPublicDrafts(companyId, site!.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["website-entries", companyId, site?.id] }),
  });
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading collections</p>;
  if (!site) return <p className="text-sm text-muted-foreground">Connect a site on Overview before editing collections.</p>;
  const selected = COLLECTIONS.find((item) => item.key === collection)!;
  return <div className="space-y-5" data-testid="website-collections">
    <div><h2 className="text-lg font-semibold">Collections</h2><p className="text-sm text-muted-foreground">Products, categories, team, redirects and forms. Approved changes go live with the next Publish.</p></div>
    {canManage ? <div className="space-y-2"><Button variant="outline" onClick={() => importDrafts.mutate()} disabled={importDrafts.isPending}>{importDrafts.isPending ? "Importing drafts" : "Import public content as drafts"}</Button><p className="text-xs text-muted-foreground">Imports 10 vendors, 32 categories, 24 products, six public team cards and three forms from the 22 October snapshot. The product list is partial. Existing entries are kept.</p>{importDrafts.data ? <p role="status" className="text-sm text-status-success">Imported {importDrafts.data.imported} drafts. Kept {importDrafts.data.skipped} existing entries.</p> : null}{importDrafts.error ? <p role="alert" className="text-sm text-status-danger">{errorStateMessage(importDrafts.error)}</p> : null}</div> : null}
    <label className="block max-w-sm space-y-1 text-sm"><span className="font-medium">Collection</span><NativeSelect value={collection} onChange={(event) => { setCollection(event.target.value); setEntryId(undefined); }}>{COLLECTIONS.filter((item) => websiteCollectionManifest.collections[item.key]).map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</NativeSelect></label>
    {entryId !== undefined ? <EntryEditor key={`${collection}:${entryId ?? "new"}`} companyId={companyId} siteId={site.id} collection={collection} entryId={entryId} onClose={() => setEntryId(undefined)} /> :
      <section className="space-y-4"><div className="flex items-center justify-between gap-2"><h3 className="text-base font-semibold">{selected.label}</h3><Button onClick={() => setEntryId(null)}>New {selected.singular}</Button></div>
        {entries.error ? <ErrorState error={entries.error} onRetry={() => void entries.refetch()} /> : entries.isLoading ? <p className="text-sm text-muted-foreground">Loading entries</p> : entries.data?.length ?
          <ul className="divide-y">{entries.data.map((entry) => <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"><div><span className="font-medium">{entry.entryKey}</span><span className="ml-2 text-muted-foreground">{entry.status}</span><p className="text-muted-foreground">Version {entry.latestRevisionNumber}, {formatDateTime(entry.updatedAt)}</p></div><Button variant="outline" size="sm" onClick={() => setEntryId(entry.id)}>Edit</Button></li>)}</ul> :
          <div className="space-y-2"><h4 className="font-medium">{collection === "redirect" ? "No redirects" : `No ${selected.label.toLowerCase()} yet`}</h4><p className="text-sm text-muted-foreground">{collection === "redirect" ? "Add one when a page moves, so old links keep working." : `Add the first ${selected.singular} and save it as a draft. After a person approves it, it goes live with the next Publish.`}</p></div>}
      </section>}
  </div>;
}

import { useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, KeyRound, Lock, RefreshCw } from "lucide-react";
import type { CommerceRow } from "@/api/website-commerce";
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
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { formatMinor, statusLabel, text } from "@/lib/commerce";
import { BRIDGE_KEY_SETTINGS_PATH, bodyFromForm, commerceWriteFailure, formValuesOf, type CommerceFieldDef } from "@/lib/commerce-write";
import { Link } from "@/lib/router";
import { cn, formatDateTime } from "@/lib/utils";

// Shared parts of the Commerce write screens (GRE-3972): the answer to a failed change, a form field, and the
// people-only line agents see in place of the buttons they cannot use.

const NOTICE = "flex gap-3 rounded-lg border p-3 text-sm";

/** A few readable facts of the row as it is now on the site, for a conflict. */
function currentFacts(row: CommerceRow) {
  const facts: { label: string; value: string }[] = [];
  const push = (label: string, value: string | null) => { if (value) facts.push({ label, value }); };
  push("Name", text(row.name) ?? text(row.invoice_number) ?? text(row.reference));
  push("Status", text(row.status) ? statusLabel(text(row.status)!) : null);
  push("Rate", text(row.usd_to_gbp_display_rate));
  push("Total", formatMinor(row.quoted_total_minor ?? row.total_minor, row.currency));
  push("PO reference", text(row.po_reference));
  push("Version", text(row.row_version));
  const updated = text(row.updated_at);
  push("Changed", updated && !Number.isNaN(Date.parse(updated)) ? formatDateTime(updated) : null);
  return facts;
}

/**
 * Why a change did not go through, in the screen's words: no write key yet, people only, a conflict (with the row
 * as it is now and a way to start again from it), or the server's own message.
 */
export function CommerceWriteError({ error, onUseCurrent, className }: {
  error: unknown;
  /** A conflict: load the row as it is now into the form, so the person can redo the change. */
  onUseCurrent?: (current: CommerceRow) => void;
  className?: string;
}) {
  if (!error) return null;
  const failure = commerceWriteFailure(error);
  if (failure.kind === "no_key") {
    return (
      <div role="alert" className={cn(NOTICE, "border-status-warning/40 bg-status-warning-soft text-status-warning-foreground", className)} data-testid="commerce-no-key">
        <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{failure.capability === "refund_request" ? "No refund key yet" : "No write key yet"}</p>
          <p>
            GSAM cannot change the website until a person makes its {failure.capability === "refund_request" ? "refund" : "write"} key.
            Nothing was sent to the site.
          </p>
          <Link to={BRIDGE_KEY_SETTINGS_PATH} className="inline-flex font-medium underline underline-offset-4">
            Open the bridge key settings
          </Link>
        </div>
      </div>
    );
  }
  if (failure.kind === "people_only") {
    return (
      <div role="alert" className={cn(NOTICE, "border-border bg-muted text-foreground", className)} data-testid="commerce-people-only-error">
        <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="min-w-0">{failure.message}</p>
      </div>
    );
  }
  if (failure.kind === "licence_key_in_text") {
    // never echo the refused text: it holds a full key
    return (
      <div role="alert" className={cn(NOTICE, "border-destructive/40 bg-destructive/10 text-foreground", className)} data-testid="commerce-licence-key-in-text">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium">The steps hold a full licence key.</p>
          <p>The website refused them and kept the steps it had. Take the key out, then save again.</p>
        </div>
      </div>
    );
  }
  if (failure.kind === "conflict") {
    const facts = failure.current ? currentFacts(failure.current) : [];
    return (
      <div role="alert" className={cn(NOTICE, "border-status-warning/40 bg-status-warning-soft text-status-warning-foreground", className)} data-testid="commerce-conflict">
        <RefreshCw className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-medium">Someone changed this on the website since you opened it.</p>
          <p>Nothing was saved. Start again from the current version, then redo your change.</p>
          {facts.length ? (
            <dl className="grid gap-x-4 gap-y-1 rounded-md border border-border bg-background p-2 text-foreground sm:grid-cols-2" data-testid="commerce-conflict-current">
              {facts.map((fact) => (
                <div key={fact.label} className="flex min-w-0 gap-2">
                  <dt className="shrink-0 text-muted-foreground">{fact.label}</dt>
                  <dd className="min-w-0 break-words">{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {failure.current && onUseCurrent ? (
            <Button type="button" size="sm" variant="outline" onClick={() => onUseCurrent(failure.current!)}>
              Use the current version
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div role="alert" className={cn(NOTICE, "border-destructive/40 bg-destructive/10 text-foreground", className)} data-testid="commerce-write-error">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <p className="min-w-0 break-words">{failure.message}</p>
    </div>
  );
}

/** What an agent (or anyone who is not a person in GSAM) sees in place of a people-only button. */
export function PeopleOnlyNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="commerce-people-only-note">
      <Lock className="size-3.5 shrink-0" aria-hidden="true" />
      {children}
    </p>
  );
}

/** One field of a commerce form, labelled, with its help line. */
export function CommerceField({ field, id, value, onChange, refOptions, disabled }: {
  field: CommerceFieldDef;
  id: string;
  value: string;
  onChange: (value: string) => void;
  refOptions?: readonly { value: string; label: string }[];
  disabled?: boolean;
}) {
  const helpId = field.help ? `${id}-help` : undefined;
  const label = `${field.label}${field.required ? "" : " (optional)"}`;
  let control: ReactNode;
  if (field.kind === "bool") {
    return (
      <div className={cn("flex min-w-0 items-center justify-between gap-3 rounded-md border border-border px-3 py-2", field.wide && "sm:col-span-2")}>
        <span className="min-w-0">
          <span id={`${id}-label`} className="block text-sm font-medium">{field.label}</span>
          {field.help ? <span id={helpId} className="block text-xs text-muted-foreground">{field.help}</span> : null}
        </span>
        <ToggleSwitch
          checked={value === "true"}
          onCheckedChange={(checked) => onChange(checked ? "true" : "false")}
          aria-labelledby={`${id}-label`}
          disabled={disabled}
        />
      </div>
    );
  }
  if (field.kind === "textarea") {
    control = <Textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={4} aria-describedby={helpId} disabled={disabled} />;
  } else if (field.kind === "select" || field.kind === "ref") {
    const options = field.kind === "ref" ? refOptions ?? [] : field.options ?? [];
    control = (
      <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={helpId} disabled={disabled}>
        {field.required && value ? null : <option value="">{field.required ? "Choose one" : "None"}</option>}
        {/* a saved choice that is not in the list stays chosen; a ref's value is an id, so it is never shown */}
        {value && !options.some((option) => option.value === value)
          ? <option value={value}>{field.kind === "ref" ? "Current choice (no longer in the list)" : value}</option> : null}
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </NativeSelect>
    );
  } else {
    const type = field.kind === "datetime" ? "datetime-local" : field.kind === "date" ? "date" : "text";
    const inputMode = field.kind === "money" || field.kind === "decimal" ? "decimal" : field.kind === "int" ? "numeric" : undefined;
    control = (
      <Input
        id={id}
        type={type}
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={helpId}
        aria-required={field.required || undefined}
        disabled={disabled}
        className={field.kind === "money" || field.kind === "decimal" || field.kind === "int" ? "tabular-nums" : undefined}
      />
    );
  }
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", field.wide && "sm:col-span-2")}>
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {control}
      {field.help ? <p id={helpId} className="text-xs text-muted-foreground">{field.help}</p> : null}
    </div>
  );
}

/** A button that asks first. For deletes, publishing, issuing and applying. */
export function ConfirmButton({ label, ariaLabel, title, description, confirmLabel, onConfirm, disabled, variant = "outline", destructive, testId }: {
  label: ReactNode;
  /** The button's name when its label is only an icon. */
  ariaLabel?: string;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  variant?: "default" | "outline" | "destructive" | "ghost";
  destructive?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size={ariaLabel ? "icon-xs" : "sm"} variant={variant} onClick={() => setOpen(true)} disabled={disabled}
        aria-label={ariaLabel} data-testid={testId}>
        {label}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={destructive ? buttonVariants({ variant: "destructive" }) : undefined}
              onClick={() => { setOpen(false); onConfirm(); }}
            >
              {confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** A form for one row: every filled field on create, only what changed on edit. */
export function CommerceRowForm({ idPrefix, fields, base, refOptions, saving, submitLabel, onSave, onCancel }: {
  idPrefix: string;
  fields: readonly CommerceFieldDef[];
  base: CommerceRow | null;
  /** The choices of each `ref` field, by its `ref`. */
  refOptions?: Partial<Record<string, readonly { value: string; label: string }[]>>;
  saving: boolean;
  submitLabel: string;
  onSave: (body: Record<string, unknown>) => void;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState(() => formValuesOf(fields, base));
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = bodyFromForm(fields, values, base);
    if (result.error !== null) return setProblem(result.error);
    if (base && Object.keys(result.body).length === 0) return setProblem("Nothing has changed yet.");
    setProblem(null);
    onSave(result.body);
  };
  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((field) => (
          <CommerceField
            key={field.name}
            field={field}
            id={`${idPrefix}-${field.name}`}
            value={values[field.name] ?? ""}
            onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
            refOptions={field.ref ? refOptions?.[field.ref] : undefined}
            disabled={saving}
          />
        ))}
      </div>
      {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving" : submitLabel}</Button>
        {onCancel ? <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button> : null}
      </div>
    </form>
  );
}

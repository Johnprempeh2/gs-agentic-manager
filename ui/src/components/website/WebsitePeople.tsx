import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Building2, KeyRound, Lock, ShieldCheck, Users } from "lucide-react";
import {
  WEBSITE_CLIENT_MEMBER_ROLES,
  WEBSITE_STAFF_ROLES,
  type WebsiteAccessChange,
  type WebsiteClientMember,
  type WebsiteClientMemberRole,
  type WebsitePortalApprover,
  type WebsiteProperty,
  type WebsiteStaff,
  type WebsiteStaffRole,
} from "@greatstone/shared";
import { ApiError } from "@/api/client";
import { websiteAccessApi } from "@/api/website-access";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ConfirmButton, PeopleOnlyNote } from "@/components/commerce/CommerceWriteParts";
import { useCommerceCustomers } from "@/hooks/useCommerceSite";
import { useCommercePerson } from "@/hooks/useCommerceWrite";
import { text } from "@/lib/commerce";
import { BRIDGE_KEY_SETTINGS_PATH, isDefiniteAnswer, newIdempotencyKey } from "@/lib/commerce-write";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";
import { EmptyState } from "../EmptyState";
import { ErrorState } from "../ErrorState";
import { PageSkeleton } from "../PageSkeleton";
import { useCanPublishWebsite, useWebsiteSite } from "./WebsiteSiteConnection";

// People and access (GRE-4086, GRE-4079 step 3c): the website's staff roles, portal approvers and each client
// company's members, read through the admin bridge. A person with Publish rights changes them here, in their own
// name; everyone else sees the lists. An agent asks with a card on its task (website_access_request_change).

export const STAFF_ROLE_LABEL: Record<WebsiteStaffRole, string> = {
  owner: "Owner", admin: "Admin", editor: "Editor", sales: "Sales", viewer: "Viewer",
};
export const MEMBER_ROLE_LABEL: Record<WebsiteClientMemberRole, string> = { admin: "Company admin", member: "Member" };

const CARD = "rounded-xl border border-border bg-card";
const ROW = "flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4";
const PILL = "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium";
const NOTICE = "flex gap-3 rounded-lg border p-3 text-sm";

const accessKey = (companyId: string, siteId: string, ...rest: string[]) =>
  queryKeys.website.data(companyId, siteId, "access", ...rest);

/** What the site's "conflict" means for each change: the site sends the code only. */
const CONFLICT_COPY: Partial<Record<WebsiteAccessChange["kind"], string>> = {
  staff_role: "The website keeps at least one active owner. Make someone else the owner first.",
  approver_set: "Only active staff with a website sign-in can approve portal documents.",
  member_add: "The website refused this person. Their email belongs to staff or to another client company, or they "
    + "are already a member here with another role. To change a member's role, use their row.",
};

export function accessChangeMessage(error: unknown, kind: WebsiteAccessChange["kind"] | null): {
  tone: "warning" | "muted" | "danger"; title?: string; message: string; keyLink?: boolean;
} {
  const message = error instanceof Error && error.message.trim() ? error.message : "The change did not go through. Try again.";
  if (!(error instanceof ApiError)) return { tone: "danger", message };
  const body = error.body && typeof error.body === "object" ? (error.body as Record<string, unknown>) : {};
  const details = body.details && typeof body.details === "object" ? (body.details as Record<string, unknown>) : {};
  const code = text(body.code) ?? text(details.code);
  if (error.status === 409 && code === "capability_not_configured") {
    return { tone: "warning", title: "No write key yet", keyLink: true,
      message: "GSAM cannot change access on the website until a person makes its write key. Nothing was sent to the site." };
  }
  if (error.status === 403 && code === "website_access_people_only") return { tone: "muted", message };
  if (error.status === 409 && code === "website_bridge_conflict" && kind && CONFLICT_COPY[kind]) {
    return { tone: "warning", title: "Nothing changed", message: CONFLICT_COPY[kind]! };
  }
  return { tone: "danger", message };
}

function AccessChangeError({ error, kind }: { error: unknown; kind: WebsiteAccessChange["kind"] | null }) {
  if (!error) return null;
  const answer = accessChangeMessage(error, kind);
  const Icon = answer.keyLink ? KeyRound : answer.tone === "muted" ? Lock : AlertTriangle;
  return (
    <div
      role="alert"
      data-testid="website-access-error"
      className={cn(NOTICE,
        answer.tone === "warning" && "border-status-warning/40 bg-status-warning-soft text-status-warning-foreground",
        answer.tone === "muted" && "border-border bg-muted text-foreground",
        answer.tone === "danger" && "border-destructive/40 bg-destructive/10 text-foreground")}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", answer.tone === "danger" && "text-destructive")} aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        {answer.title ? <p className="font-medium">{answer.title}</p> : null}
        <p className="break-words">{answer.message}</p>
        {answer.keyLink ? (
          <Link to={BRIDGE_KEY_SETTINGS_PATH} className="inline-flex font-medium underline underline-offset-4">
            Open the bridge key settings
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One access change at a time, in the signed-in person's name. A retry of the same change (after a network error or
 * a 5xx) reuses its Idempotency-Key, so the site makes it once. Every success refreshes this site's access reads.
 */
function useAccessChange(companyId: string, siteId: string, onSuccess?: () => void) {
  const queryClient = useQueryClient();
  const pending = useRef<{ signature: string; key: string } | null>(null);
  const [kind, setKind] = useState<WebsiteAccessChange["kind"] | null>(null);
  const mutation = useMutation({
    mutationFn: (change: WebsiteAccessChange) => {
      setKind(change.kind);
      const signature = JSON.stringify(change);
      if (pending.current?.signature !== signature) pending.current = { signature, key: newIdempotencyKey() };
      return websiteAccessApi.change(companyId, siteId, change, pending.current.key);
    },
    onSuccess: () => {
      pending.current = null;
      void queryClient.invalidateQueries({ queryKey: accessKey(companyId, siteId) });
      onSuccess?.();
    },
    onError: (error) => {
      if (isDefiniteAnswer(error)) pending.current = null;
    },
  });
  return { ...mutation, kind };
}

function Section({ icon: Icon, title, description, action, children, testId }: {
  icon: typeof Users; title: string; description: string; action?: ReactNode; children: ReactNode; testId: string;
}) {
  const id = useId();
  return (
    <section className="min-w-0 space-y-3" aria-labelledby={id} data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h3 id={id} className="flex items-center gap-2 text-base font-semibold">
            <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
            {title}
          </h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Who({ name, email, children }: { name: string | null; email: string; children?: ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
        <span className="min-w-0 break-words">{name || email}</span>
        {children}
      </p>
      {name ? <p className="break-all text-xs text-muted-foreground">{email}</p> : null}
    </div>
  );
}

/** A role picker that asks before it changes anything. */
function RoleSelect<R extends string>({ label, value, roles, labels, disabled, onConfirm, describe }: {
  label: string;
  value: R;
  roles: readonly R[];
  labels: Record<R, string>;
  disabled?: boolean;
  onConfirm: (role: R) => void;
  describe: (role: R) => string;
}) {
  const [next, setNext] = useState<R | null>(null);
  return (
    <>
      <NativeSelect
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => setNext(event.target.value as R)}
        className="w-full sm:w-40"
      >
        {roles.map((role) => <option key={role} value={role}>{labels[role]}</option>)}
      </NativeSelect>
      <AlertDialog open={next !== null && next !== value} onOpenChange={(open) => { if (!open) setNext(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change the role to {next ? labels[next] : ""}?</AlertDialogTitle>
            <AlertDialogDescription>{next ? describe(next) : ""}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (next) onConfirm(next); setNext(null); }}>Change role</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function listState(query: { isLoading: boolean; error: unknown; refetch: () => unknown; isFetching: boolean }) {
  if (query.isLoading) return <PageSkeleton variant="list" />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  return null;
}

function staffMeta(staff: WebsiteStaff) {
  if (!staff.isActive) return "Inactive";
  if (!staff.canSignIn) return "No website sign-in";
  return staff.lastLoginAt ? `Last signed in ${relativeTime(staff.lastLoginAt)}` : "Never signed in";
}

function StaffSection({ companyId, siteId, staff, canChange }: {
  companyId: string; siteId: string; staff: ReturnType<typeof useStaff>; canChange: boolean;
}) {
  const change = useAccessChange(companyId, siteId);
  const rows = staff.data?.items ?? [];
  return (
    <Section icon={Users} title="Staff" testId="website-access-staff"
      description="Who works in the website admin, and what each role may do there. Staff are added on the website.">
      <AccessChangeError error={change.error} kind={change.kind} />
      {listState(staff)}
      {staff.data && rows.length === 0 ? <EmptyState icon={Users} message="The website has no staff yet." /> : null}
      {rows.length ? (
        <ul className={cn(CARD, "divide-y divide-border")}>
          {rows.map((member) => (
            <li key={member.id} className={ROW} data-testid="website-access-staff-row">
              <Who name={member.name} email={member.email}>
                {member.portalApprover ? <span className={cn(PILL, "bg-status-info-soft text-status-info-foreground")}>Portal approver</span> : null}
              </Who>
              <p className={cn("text-xs sm:w-40 sm:text-right", member.isActive ? "text-muted-foreground" : "text-status-warning-foreground")}
                title={member.lastLoginAt ? formatDateTime(member.lastLoginAt) : undefined}>
                {staffMeta(member)}
              </p>
              {canChange ? (
                <RoleSelect
                  label={`Role for ${member.name || member.email}`}
                  value={member.role}
                  roles={WEBSITE_STAFF_ROLES}
                  labels={STAFF_ROLE_LABEL}
                  disabled={change.isPending}
                  describe={(role) => `${member.name || member.email} becomes ${STAFF_ROLE_LABEL[role]} on the website now. The change is made in your name.`}
                  onConfirm={(role) => change.mutate({ kind: "staff_role", staffId: member.id, role })}
                />
              ) : (
                <span className={cn(PILL, "w-fit bg-muted text-muted-foreground")}>{STAFF_ROLE_LABEL[member.role]}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function ApproverLabel({ approver, disabled, onSave }: { approver: WebsitePortalApprover; disabled: boolean; onSave: (label: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(approver.label);
  if (!editing) {
    return (
      <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => { setLabel(approver.label); setEditing(true); }}>
        Rename
      </Button>
    );
  }
  const save = (event: FormEvent) => {
    event.preventDefault();
    const value = label.trim();
    if (!value || value === approver.label) return setEditing(false);
    onSave(value);
    setEditing(false);
  };
  return (
    <form onSubmit={save} className="flex w-full items-center gap-2 sm:w-auto">
      <Input aria-label={`Label for ${approver.name || approver.email}`} value={label} maxLength={100}
        onChange={(event) => setLabel(event.target.value)} className="h-8 min-w-0 flex-1 sm:w-44" autoFocus />
      <Button type="submit" size="sm">Save</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
    </form>
  );
}

function ApproversSection({ companyId, siteId, staff, canChange }: {
  companyId: string; siteId: string; staff: WebsiteStaff[]; canChange: boolean;
}) {
  const approvers = useQuery({
    queryKey: accessKey(companyId, siteId, "portal-approvers"),
    queryFn: () => websiteAccessApi.portalApprovers(companyId, siteId),
  });
  const [staffId, setStaffId] = useState("");
  const [label, setLabel] = useState("");
  const change = useAccessChange(companyId, siteId, () => { setStaffId(""); setLabel(""); });
  const rows = approvers.data?.items ?? [];
  const listed = new Set(rows.map((row) => row.staffId));
  const eligible = staff.filter((member) => member.isActive && member.canSignIn && !listed.has(member.id));
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!staffId || !label.trim()) return;
    change.mutate({ kind: "approver_set", staffId, label: label.trim() });
  };
  return (
    <Section icon={ShieldCheck} title="Portal approvers" testId="website-access-approvers"
      description="Staff who approve and publish documents in the client portal. They still sign in to the website to do it.">
      <AccessChangeError error={change.error} kind={change.kind} />
      {listState(approvers)}
      {approvers.data && rows.length === 0 ? <EmptyState icon={ShieldCheck} message="No one approves portal documents yet." /> : null}
      {rows.length ? (
        <ul className={cn(CARD, "divide-y divide-border")}>
          {rows.map((approver) => (
            <li key={approver.staffId} className={ROW} data-testid="website-access-approver-row">
              <Who name={approver.name} email={approver.email}>
                <span className={cn(PILL, "bg-muted text-muted-foreground")}>{approver.label}</span>
                {approver.staffActive ? null : (
                  <span className={cn(PILL, "bg-status-warning-soft text-status-warning-foreground")}>Staff inactive</span>
                )}
              </Who>
              {canChange ? (
                <div className="flex flex-wrap items-center gap-2">
                  <ApproverLabel approver={approver} disabled={change.isPending}
                    onSave={(value) => change.mutate({ kind: "approver_set", staffId: approver.staffId, label: value })} />
                  <ConfirmButton
                    label="Remove"
                    title={`Remove ${approver.name || approver.email} as a portal approver?`}
                    description="They stay on the staff list. They can no longer approve or publish portal documents."
                    confirmLabel="Remove approver"
                    destructive
                    disabled={change.isPending}
                    onConfirm={() => change.mutate({ kind: "approver_remove", staffId: approver.staffId })}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canChange && approvers.data ? (
        <form onSubmit={add} className={cn(CARD, "flex flex-col gap-3 p-4 sm:flex-row sm:items-end")}
          data-testid="website-access-approver-add">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            <span className="font-medium">Staff member</span>
            <NativeSelect value={staffId} onChange={(event) => setStaffId(event.target.value)} disabled={eligible.length === 0}>
              <option value="">{eligible.length ? "Pick a staff member" : "Every active staff member is listed"}</option>
              {eligible.map((member) => <option key={member.id} value={member.id}>{member.name || member.email}</option>)}
            </NativeSelect>
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
            <span className="font-medium">Label</span>
            <Input value={label} maxLength={100} placeholder="For example Director" onChange={(event) => setLabel(event.target.value)} />
          </label>
          <Button type="submit" disabled={!staffId || !label.trim() || change.isPending}>
            {change.isPending ? "Adding" : "Add approver"}
          </Button>
        </form>
      ) : null}
    </Section>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function AddMember({ disabled, onAdd }: { disabled: boolean; onAdd: (input: { name: string; email: string; role: WebsiteClientMemberRole }) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WebsiteClientMemberRole>("member");
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setProblem("Enter their name.");
    if (!EMAIL.test(email.trim())) return setProblem("Enter an email like name@company.com.");
    setProblem(null);
    onAdd({ name: name.trim(), email: email.trim().toLowerCase(), role });
  };
  return (
    <form onSubmit={submit} className={cn(CARD, "space-y-3 p-4")} data-testid="website-access-member-add" noValidate>
      <p className="text-sm font-semibold">Add a person</p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">Name</span>
          <Input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">Email</span>
          <Input type="email" value={email} maxLength={320} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm sm:w-40">
          <span className="font-medium">Role</span>
          <NativeSelect value={role} onChange={(event) => setRole(event.target.value as WebsiteClientMemberRole)}>
            {WEBSITE_CLIENT_MEMBER_ROLES.map((value) => <option key={value} value={value}>{MEMBER_ROLE_LABEL[value]}</option>)}
          </NativeSelect>
        </label>
        <Button type="submit" disabled={disabled}>{disabled ? "Adding" : "Add person"}</Button>
      </div>
      {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
      <p className="text-xs text-muted-foreground">
        The website makes their sign-in with no password. They set one from the email the website sends them.
      </p>
    </form>
  );
}

function MembersList({ companyId, siteId, customerId, companyName, canChange }: {
  companyId: string; siteId: string; customerId: string; companyName: string; canChange: boolean;
}) {
  const members = useQuery({
    queryKey: accessKey(companyId, siteId, "clients", customerId),
    queryFn: () => websiteAccessApi.clientMembers(companyId, siteId, customerId),
  });
  const [addKey, setAddKey] = useState(0);
  const change = useAccessChange(companyId, siteId, () => setAddKey((value) => value + 1));
  const rows: WebsiteClientMember[] = members.data?.items ?? [];
  return (
    <div className="space-y-3" data-testid="website-access-members">
      <AccessChangeError error={change.error} kind={change.kind} />
      {listState(members)}
      {members.data && rows.length === 0 ? <EmptyState icon={Users} message={`No one from ${companyName} can sign in to the portal yet.`} /> : null}
      {rows.length ? (
        <ul className={cn(CARD, "divide-y divide-border")}>
          {rows.map((member) => (
            <li key={member.membershipId} className={ROW} data-testid="website-access-member-row">
              <Who name={member.name} email={member.email}>
                {member.isPrimary ? <span className={cn(PILL, "bg-status-info-soft text-status-info-foreground")}>Main contact</span> : null}
                {member.userId ? null : <span className={cn(PILL, "bg-muted text-muted-foreground")}>No sign-in</span>}
              </Who>
              {canChange ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <RoleSelect
                    label={`Role for ${member.name || member.email}`}
                    value={member.role}
                    roles={WEBSITE_CLIENT_MEMBER_ROLES}
                    labels={MEMBER_ROLE_LABEL}
                    disabled={change.isPending}
                    describe={(role) => `${member.name || member.email} becomes ${MEMBER_ROLE_LABEL[role]} for ${companyName} now. The change is made in your name.`}
                    onConfirm={(role) => change.mutate({ kind: "member_role", customerId, membershipId: member.membershipId, role })}
                  />
                  <ConfirmButton
                    label="Remove"
                    title={`Remove ${member.name || member.email} from ${companyName}?`}
                    description="They keep their website sign-in, but they no longer see this company in the portal. Adding them again later links the same membership."
                    confirmLabel="Remove person"
                    destructive
                    disabled={change.isPending}
                    onConfirm={() => change.mutate({ kind: "member_remove", customerId, membershipId: member.membershipId })}
                  />
                </div>
              ) : (
                <span className={cn(PILL, "w-fit bg-muted text-muted-foreground")}>{MEMBER_ROLE_LABEL[member.role]}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {canChange && members.data ? (
        <AddMember key={addKey} disabled={change.isPending}
          onAdd={(input) => change.mutate({ kind: "member_add", customerId, ...input })} />
      ) : null}
    </div>
  );
}

function ClientsSection({ companyId, siteId, canChange }: { companyId: string; siteId: string; canChange: boolean }) {
  const customers = useCommerceCustomers(companyId, siteId);
  const [customerId, setCustomerId] = useState("");
  const companies = (customers.data ?? [])
    .map((row) => ({ id: text(row.id) ?? "", name: text(row.name) ?? text(row.domain) ?? "Unnamed company" }))
    .filter((row) => row.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  const selected = companies.find((row) => row.id === customerId) ?? null;
  return (
    <Section icon={Building2} title="Client companies" testId="website-access-clients"
      description="Who from each client company signs in to the portal, and who manages the company there.">
      {listState(customers)}
      {customers.data && companies.length === 0 ? <EmptyState icon={Building2} message="The website has no client companies yet." /> : null}
      {companies.length ? (
        <label className="flex max-w-sm flex-col gap-1 text-sm">
          <span className="font-medium">Company</span>
          <NativeSelect value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
            <option value="">Pick a client company</option>
            {companies.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </NativeSelect>
        </label>
      ) : null}
      {selected ? (
        <MembersList key={selected.id} companyId={companyId} siteId={siteId} customerId={selected.id} companyName={selected.name} canChange={canChange} />
      ) : null}
    </Section>
  );
}

function useStaff(companyId: string, siteId: string) {
  return useQuery({
    queryKey: accessKey(companyId, siteId, "staff"),
    queryFn: () => websiteAccessApi.staff(companyId, siteId),
  });
}

export function WebsitePeople({ companyId, siteId }: { companyId: string; siteId: string }) {
  const isPerson = useCommercePerson();
  const { canPublish } = useCanPublishWebsite(companyId, siteId);
  const canChange = isPerson && canPublish;
  const staff = useStaff(companyId, siteId);
  return (
    <div className="space-y-8" data-testid="website-people">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">People and access</h2>
        <p className="text-sm text-muted-foreground">
          Who signs in to the website admin, who approves portal documents, and who sees each client company in the portal.
        </p>
        {canChange ? null : (
          <PeopleOnlyNote>
            {isPerson
              ? "You can see access here. A person with Publish rights for this site changes it."
              : "Only a person with Publish rights changes access, in GSAM. An agent asks with a card on its task."}
          </PeopleOnlyNote>
        )}
      </div>
      <StaffSection companyId={companyId} siteId={siteId} staff={staff} canChange={canChange} />
      <ApproversSection companyId={companyId} siteId={siteId} staff={staff.data?.items ?? []} canChange={canChange} />
      <ClientsSection companyId={companyId} siteId={siteId} canChange={canChange} />
    </div>
  );
}

export function WebsitePeopleTab({ companyId, property }: { companyId: string; property: WebsiteProperty }) {
  const { site, isLoading, error } = useWebsiteSite(companyId, property.id);
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <PageSkeleton variant="list" />;
  if (!site) {
    return (
      <EmptyState
        icon={Users}
        title="Connect the site first"
        message="People and access reads the connected site's staff and client companies. Connect a site under Releases."
      />
    );
  }
  return <WebsitePeople companyId={companyId} siteId={site.id} />;
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileText } from "lucide-react";
import type { PublicClientDeliverable } from "@greatstone/shared";
import { useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "../api/client";
import { clientDeliverableApi } from "../api/clientPublications";
import { formatDate } from "../lib/utils";

// The page a client opens to read and accept a published deliverable
// (GRE-2373), like the engagement pack page. No sign-in: they read it, type
// their name and email, tick that they accept it, and get a receipt by email.

function day(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatDate(date) : value;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground">
      <div className="mx-auto w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-sm">{children}</div>
    </main>
  );
}

function ReadLink({ view }: { view: PublicClientDeliverable }) {
  const href = view.contentPath ?? view.url;
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-md border border-border p-3 text-sm font-medium hover:bg-accent"
    >
      <FileText className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      Read {view.title}{view.version ? ` (version ${view.version})` : ""}
    </a>
  );
}

export function ClientDeliverablePage() {
  const { token = "" } = useParams<{ token: string }>();
  const queryClient = useQueryClient();
  const queryKey = ["client-deliverable", token];
  const view = useQuery({ queryKey, queryFn: () => clientDeliverableApi.get(token), retry: false });
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [email, setEmail] = useState("");
  const [agree, setAgree] = useState(false);
  const accept = useMutation({
    mutationFn: () => clientDeliverableApi.accept(token, { name: name.trim(), role: role.trim() || null, email: email.trim(), agree: true }),
    onSuccess: (result) => queryClient.setQueryData(queryKey, result),
  });

  if (view.isLoading) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">Loading...</p>
      </Shell>
    );
  }
  if (view.error || !view.data) {
    const missing = view.error instanceof ApiError && view.error.status === 404;
    return (
      <Shell>
        <div className="space-y-2" data-testid="client-deliverable-missing">
          <h1 className="text-lg font-semibold">This link is not available</h1>
          <p className="text-sm text-muted-foreground">
            {missing
              ? "It may have expired, been withdrawn or been replaced by a newer link. Ask your contact to send you a new one."
              : "We could not load this page. Please try again in a moment."}
          </p>
        </div>
      </Shell>
    );
  }

  const data = view.data;
  if (data.status === "accepted") {
    return (
      <Shell>
        <div className="space-y-3" data-testid="client-deliverable-done">
          <CheckCircle2 className="h-8 w-8 text-status-success" aria-hidden="true" />
          <h1 className="text-lg font-semibold">Thank you, it is accepted</h1>
          <p className="text-sm text-muted-foreground">
            {data.acceptedName ? `${data.acceptedName} accepted` : "You accepted"} {data.title} for {data.clientName} on {day(data.acceptedAt)}.
            A receipt is on its way to your email.
          </p>
          <ReadLink view={data} />
        </div>
      </Shell>
    );
  }

  const ready = name.trim().length >= 2 && /\S+@\S+\.\S+/.test(email.trim()) && agree;
  return (
    <Shell>
      <div className="space-y-5" data-testid="client-deliverable-form">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{data.companyName}</p>
          <h1 className="text-lg font-semibold">{data.title} for {data.clientName}</h1>
          <p className="text-sm text-muted-foreground">
            Please read it, then accept it below. This link works until {day(data.expiresAt)}.
          </p>
        </div>
        <ReadLink view={data} />
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !accept.isPending) accept.mutate();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="client-deliverable-name">Your full name</Label>
            <Input id="client-deliverable-name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="client-deliverable-role">Your role (optional)</Label>
            <Input id="client-deliverable-role" autoComplete="organization-title" value={role} onChange={(event) => setRole(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="client-deliverable-email">Your email (we send the receipt here)</Label>
            <Input id="client-deliverable-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          <div className="flex items-start gap-2">
            <Checkbox id="client-deliverable-agree" checked={agree} onCheckedChange={(checked) => setAgree(checked === true)} className="mt-0.5" />
            <Label htmlFor="client-deliverable-agree" className="text-sm font-normal leading-snug">
              I have read {data.title} and accept it on behalf of {data.clientName}.
            </Label>
          </div>
          {accept.error ? (
            <p className="text-sm text-destructive" role="alert">
              {accept.error instanceof Error ? accept.error.message : "We could not record your acceptance. Please try again."}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" disabled={!ready || accept.isPending}>
              {accept.isPending ? "Accepting..." : "Accept"}
            </Button>
          </div>
        </form>
      </div>
    </Shell>
  );
}

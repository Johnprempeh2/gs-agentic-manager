import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileText } from "lucide-react";
import type { PublicClientAcceptance } from "@greatstone/shared";
import { useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "../api/client";
import { clientAcceptanceApi } from "../api/clientAcceptance";
import { formatDate } from "../lib/utils";

// The page a client opens from the link we send them (John's yes, 16 Oct). No
// sign-in: they read the engagement pack, type their name and email, tick that
// they accept it, and see a confirmation. It shows nothing else of GSAM.

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

function Accepted({ view }: { view: PublicClientAcceptance }) {
  return (
    <div className="space-y-3" data-testid="client-acceptance-done">
      <CheckCircle2 className="h-8 w-8 text-status-success" aria-hidden="true" />
      <h1 className="text-lg font-semibold">Thank you, it is accepted</h1>
      <p className="text-sm text-muted-foreground">
        {view.acceptedName ? `${view.acceptedName} accepted` : "You accepted"} the engagement pack for {view.clientName} on{" "}
        {day(view.acceptedAt)}. {view.companyName} has been told and will be in touch about next steps.
      </p>
      <a href={view.packPath} target="_blank" rel="noopener noreferrer" className="text-sm text-foreground underline">
        Keep a copy of the engagement pack
      </a>
    </div>
  );
}

export function ClientAcceptancePage() {
  const { token = "" } = useParams<{ token: string }>();
  const queryClient = useQueryClient();
  const queryKey = ["client-acceptance", token];
  const view = useQuery({
    queryKey,
    queryFn: () => clientAcceptanceApi.get(token),
    retry: false,
  });
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [email, setEmail] = useState("");
  const [agree, setAgree] = useState(false);

  const accept = useMutation({
    mutationFn: () => clientAcceptanceApi.accept(token, { name: name.trim(), role: role.trim() || null, email: email.trim(), agree: true }),
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
        <div className="space-y-2" data-testid="client-acceptance-missing">
          <h1 className="text-lg font-semibold">This link is not available</h1>
          <p className="text-sm text-muted-foreground">
            {missing
              ? "It may have expired or been replaced by a newer link. Ask your contact to send you a new one."
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
        <Accepted view={data} />
      </Shell>
    );
  }

  const ready = name.trim().length >= 2 && /\S+@\S+\.\S+/.test(email.trim()) && agree;
  return (
    <Shell>
      <div className="space-y-5" data-testid="client-acceptance-form">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{data.companyName}</p>
          <h1 className="text-lg font-semibold">Engagement pack for {data.clientName}</h1>
          <p className="text-sm text-muted-foreground">
            Please read the engagement pack, then accept it below. This link works until {day(data.expiresAt)}.
          </p>
        </div>
        <a
          href={data.packPath}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 rounded-md border border-border p-3 text-sm font-medium hover:bg-accent"
        >
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          Read the engagement pack
        </a>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !accept.isPending) accept.mutate();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="client-acceptance-name">Your full name</Label>
            <Input id="client-acceptance-name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="client-acceptance-role">Your role (optional)</Label>
            <Input id="client-acceptance-role" autoComplete="organization-title" value={role} onChange={(event) => setRole(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="client-acceptance-email">Your email</Label>
            <Input
              id="client-acceptance-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="client-acceptance-agree"
              checked={agree}
              onCheckedChange={(checked) => setAgree(checked === true)}
              className="mt-0.5"
            />
            <Label htmlFor="client-acceptance-agree" className="text-sm font-normal leading-snug">
              I have read the engagement pack and accept it on behalf of {data.clientName}.
            </Label>
          </div>
          {accept.error ? (
            <p className="text-sm text-destructive" role="alert">
              {accept.error instanceof Error ? accept.error.message : "We could not record your acceptance. Please try again."}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" disabled={!ready || accept.isPending}>
              {accept.isPending ? "Accepting..." : "Accept the engagement pack"}
            </Button>
          </div>
        </form>
      </div>
    </Shell>
  );
}

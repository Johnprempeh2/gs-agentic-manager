import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ClipboardCopy, ExternalLink, FileUp, Lock, PowerOff } from "lucide-react";
import {
  MEMORY_IMPORT_APP_LABEL,
  MEMORY_IMPORT_MAX_ENTRIES,
  MEMORY_IMPORT_PROMPT,
  mergeImportResults,
  parseAssistantExport,
  parsePastedMemories,
  type MemoryImportApp,
  type MemoryImportCandidate,
  type MemoryImportCheckResult,
  type MemoryImportResult,
  type MemoryScope,
} from "@greatstone/shared";
import { Link, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { Textarea } from "@/components/ui/textarea";
import { copyTextToClipboard } from "@/lib/clipboard";
import { formatDate } from "@/lib/utils";
import { ApiError } from "../api/client";
import { memoryGraphApi } from "../api/memoryGraph";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { MemoryConnectionsSection } from "../components/memory/MemoryConnectionsSection";
import { MemoryPageHeader } from "../components/memory/MemoryPageHeader";
import { isMemoryDisabled } from "./Memory";

type Method = "paste" | "export";

const APP_LINK: Record<MemoryImportApp, string> = {
  claude: "https://claude.ai/new",
  chatgpt: "https://chatgpt.com/",
};

/** Where each app keeps its data export, in the words of its own settings screens. */
export const EXPORT_STEPS: Record<MemoryImportApp, string[]> = {
  chatgpt: [
    "In ChatGPT, open Settings, then Data controls, then Export data, and confirm.",
    "ChatGPT emails you a link. Download the file and open it, so it becomes a folder.",
    "Choose the conversations.json file from that folder below.",
  ],
  claude: [
    "In Claude, open Settings, then Privacy, then Export data.",
    "Claude emails you a link. Download the file and open it, so it becomes a folder.",
    "Choose the conversations.json file from that folder below. A memories.json file works too.",
  ],
};

const SCOPE_KIND_HINT: Record<string, string> = {
  organization: "everyone in the organisation",
  project: "people and agents on this project",
  restricted_project: "only people named on this project",
  client: "only people working with this client",
  agent: "one agent's working notes",
};

/** The scope offered first: the organisation scope, else the first one listed. */
export function defaultScopeId(scopes: MemoryScope[]): string {
  return (scopes.find((scope) => scope.kind === "organization") ?? scopes[0])?.id ?? "";
}

const CHECK_BATCH = 200;
/** Past this many, only the newest are checked against memory; the rest still import and skip repeats. */
const CHECK_MAX = 2_000;

type ImportMatch = MemoryImportCheckResult["entries"][number];

/** Checks the candidates against memory in batches small enough for one request each. */
export async function checkCandidates(
  companyId: string,
  scopeId: string,
  app: MemoryImportApp,
  candidates: MemoryImportCandidate[],
): Promise<Map<string, ImportMatch>> {
  const matches = new Map<string, ImportMatch>();
  const toCheck = candidates.slice(0, CHECK_MAX);
  for (let start = 0; start < toCheck.length; start += CHECK_BATCH) {
    const batch = toCheck.slice(start, start + CHECK_BATCH);
    const result = await memoryGraphApi.checkImport(companyId, {
      scopeId,
      app,
      entries: batch.map((candidate) => ({ sourceId: candidate.sourceId, content: candidate.content })),
    });
    for (const entry of result.entries) if (entry.match) matches.set(entry.sourceId, entry);
  }
  return matches;
}

function MatchNote({ match }: { match: ImportMatch }) {
  if (match.match === "already_imported") {
    return <p className="text-xs text-muted-foreground">Already in memory, so it is unticked.</p>;
  }
  return (
    <p className="text-xs text-muted-foreground">
      Looks like an entry already in memory{match.existing?.title ? `: "${match.existing.title}"` : ""}, so it is unticked. Tick it to add it anyway.
    </p>
  );
}

export function MemoryApps() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [app, setApp] = useState<MemoryImportApp>("chatgpt");
  const [method, setMethod] = useState<Method>("paste");
  const [params] = useSearchParams();
  // A client page links here with its scope picked.
  const [scopeId, setScopeId] = useState(params.get("scope") ?? "");
  const [pasted, setPasted] = useState("");
  const [fileCandidates, setFileCandidates] = useState<MemoryImportCandidate[] | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<MemoryImportResult | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Memory", href: "/memory" }, { label: "Claude and ChatGPT" }]);
  }, [setBreadcrumbs]);

  const scopes = useQuery({
    queryKey: queryKeys.memoryGraph.scopes(selectedCompanyId ?? ""),
    queryFn: () => memoryGraphApi.scopes(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    retry: (count, error) => !(error instanceof ApiError && (error.status === 403 || isMemoryDisabled(error))) && count < 2,
  });
  const writableScopes = useMemo(() => (scopes.data ?? []).filter((scope) => scope.kind !== "agent"), [scopes.data]);
  useEffect(() => {
    if (writableScopes.length > 0 && !writableScopes.some((scope) => scope.id === scopeId)) setScopeId(defaultScopeId(writableScopes));
  }, [scopeId, writableScopes]);

  const pastedCandidates = useMemo(() => parsePastedMemories(pasted), [pasted]);
  const candidates = useMemo(() => (method === "paste" ? pastedCandidates : (fileCandidates ?? [])), [method, pastedCandidates, fileCandidates]);

  // Kept outside the "memory-graph" key so an import does not re-run the check and re-tick the list.
  // Waits for typing to pause before checking a paste.
  const [checkTarget, setCheckTarget] = useState<MemoryImportCandidate[]>([]);
  useEffect(() => {
    const timer = window.setTimeout(() => setCheckTarget(candidates), 500);
    return () => window.clearTimeout(timer);
  }, [candidates]);
  const candidateKey = useMemo(() => checkTarget.map((candidate) => candidate.sourceId).join("|"), [checkTarget]);
  const check = useQuery({
    queryKey: ["memory-import-check", selectedCompanyId, scopeId, app, candidateKey],
    queryFn: () => checkCandidates(selectedCompanyId!, scopeId, app, checkTarget),
    enabled: !!selectedCompanyId && !!scopeId && checkTarget.length > 0,
    staleTime: Infinity,
    retry: false,
  });
  const matches = check.data;

  // A fresh paste or file picks everything new it found, up to one import's worth.
  // Anything already in memory, or much like an entry there, starts unticked.
  useEffect(() => {
    const fresh = matches ? candidates.filter((candidate) => !matches.has(candidate.sourceId)) : candidates;
    setPicked(new Set(fresh.slice(0, MEMORY_IMPORT_MAX_ENTRIES).map((candidate) => candidate.sourceId)));
    setResult(null);
  }, [candidates, matches]);
  const matchedCount = matches?.size ?? 0;

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return candidates;
    return candidates.filter((candidate) => `${candidate.title}\n${candidate.content}`.toLowerCase().includes(needle));
  }, [candidates, filter]);

  const importMutation = useMutation({
    mutationFn: () =>
      memoryGraphApi.importEntries(selectedCompanyId!, {
        scopeId,
        app,
        via: method,
        entries: candidates
          .filter((candidate) => picked.has(candidate.sourceId))
          .map((candidate) => ({
            sourceId: candidate.sourceId,
            title: candidate.title || null,
            content: candidate.content,
            occurredAt: candidate.occurredAt ? new Date(candidate.occurredAt) : null,
          })),
      }),
    onSuccess: (data) => {
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: ["memory-graph", selectedCompanyId] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.memoryReview.all(selectedCompanyId ?? "") });
    },
  });

  async function readFiles(files: File[]) {
    setFileError(null);
    setFileNote(null);
    setFileCandidates(null);
    const parsed = mergeImportResults(await Promise.all(files.map(async (file) => parseAssistantExport(await file.text()))));
    if (!parsed.ok) {
      setFileError(parsed.error);
      return;
    }
    if (parsed.app !== app) {
      setApp(parsed.app);
      setFileNote(`This file came from ${MEMORY_IMPORT_APP_LABEL[parsed.app]}, so it will be labelled as ${MEMORY_IMPORT_APP_LABEL[parsed.app]}.`);
    }
    setFileCandidates(parsed.candidates);
  }

  function toggle(sourceId: string, on: boolean) {
    setPicked((current) => {
      const next = new Set(current);
      if (on) {
        if (next.size >= MEMORY_IMPORT_MAX_ENTRIES) return current;
        next.add(sourceId);
      } else next.delete(sourceId);
      return next;
    });
  }

  async function copyPrompt() {
    await copyTextToClipboard(MEMORY_IMPORT_PROMPT);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  }

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Choose an organisation first.</p>;
  }

  const header = <MemoryPageHeader tab="apps" />;
  if (scopes.error instanceof ApiError && scopes.error.status === 403) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState icon={Lock} message="You do not have access to memory in this organisation." description="Ask a board admin if you need to see it." />
      </div>
    );
  }
  if (isMemoryDisabled(scopes.error)) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState icon={PowerOff} message="Memory is turned off for this organisation." description="A board admin can turn it on in organisation settings." />
      </div>
    );
  }
  if (scopes.isLoading) return <div className="space-y-4">{header}<PageSkeleton variant="list" /></div>;
  if (scopes.error) return <div className="space-y-4">{header}<ErrorState error={scopes.error} onRetry={() => void scopes.refetch()} /></div>;

  const appLabel = MEMORY_IMPORT_APP_LABEL[app];
  const selectedScope = writableScopes.find((scope) => scope.id === scopeId);
  const pickedCount = candidates.filter((candidate) => picked.has(candidate.sourceId)).length;
  const atLimit = pickedCount >= MEMORY_IMPORT_MAX_ENTRIES;

  return (
    <div className="space-y-4">
      {header}

      <section className="space-y-2 rounded-lg border border-border bg-card p-4">
        <h2 className="text-base font-semibold">Bring what Claude and ChatGPT know into shared memory</h2>
        <p className="text-sm text-muted-foreground">
          Your chats hold a lot of what you know about clients, prices and decisions. Bring it here so your agents can use it too.
          Nothing leaves this page until you press Add, and everything you add waits in Review until someone approves it.
        </p>
      </section>

      <section className="space-y-4 rounded-lg border border-border bg-card p-4" aria-label="Where it comes from">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">1. Which app is it from?</h3>
          <RadioCardGroup
            ariaLabel="App"
            value={app}
            onValueChange={(value) => setApp(value as MemoryImportApp)}
            options={[
              { value: "chatgpt", title: "ChatGPT", description: "From chatgpt.com or the ChatGPT app" },
              { value: "claude", title: "Claude", description: "From claude.ai or the Claude app" },
            ]}
            className="grid gap-2 sm:grid-cols-2"
          />
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">2. Who should be able to see it?</h3>
          <NativeSelect value={scopeId} onChange={(event) => setScopeId(event.target.value)} aria-label="Memory scope" className="sm:max-w-sm">
            {writableScopes.map((scope) => (
              <option key={scope.id} value={scope.id}>
                {scope.name}
              </option>
            ))}
          </NativeSelect>
          {selectedScope ? (
            <p className="text-xs text-muted-foreground">Visible to {SCOPE_KIND_HINT[selectedScope.kind] ?? "people with access to this scope"}.</p>
          ) : null}
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">3. How would you like to bring it in?</h3>
          <RadioCardGroup
            ariaLabel="Method"
            value={method}
            onValueChange={(value) => setMethod(value as Method)}
            options={[
              { value: "paste", title: "Copy what it remembers", description: "Quickest. Takes about a minute." },
              { value: "export", title: "Upload past conversations", description: "Pick whole chats from a data export." },
            ]}
            className="grid gap-2 sm:grid-cols-2"
          />
        </div>
      </section>

      {method === "paste" ? (
        <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label="Copy what it remembers">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              Copy this question.
              <div className="mt-2 space-y-2 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                <p>{MEMORY_IMPORT_PROMPT}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => void copyPrompt()}>
                  <ClipboardCopy className="size-4" />
                  {copied ? "Copied" : "Copy question"}
                </Button>
              </div>
            </li>
            <li>
              Open{" "}
              <a href={APP_LINK[app]} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
                {appLabel} <ExternalLink className="size-3" />
              </a>
              , paste the question into a new chat and send it.
            </li>
            <li>Copy its whole answer and paste it here.</li>
          </ol>
          <Textarea
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            placeholder={`Paste ${appLabel}'s answer here`}
            aria-label={`${appLabel}'s answer`}
            rows={8}
          />
        </section>
      ) : (
        <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label="Upload past conversations">
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {EXPORT_STEPS[app].map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">
            <FileUp className="size-4" />
            Choose conversations.json
            <input
              type="file"
              accept=".json,application/json"
              multiple
              className="sr-only"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length > 0) void readFiles(files);
                event.target.value = "";
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            The file is read on this computer. Only the chats you tick are sent. If the export came as several conversations files, choose them all at once.
          </p>
          {fileError ? <p className="text-sm text-destructive">{fileError}</p> : null}
          {fileNote ? <p className="text-sm text-muted-foreground">{fileNote}</p> : null}
        </section>
      )}

      {candidates.length > 0 ? (
        <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label="Pick what to add">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              4. Pick what to add ({pickedCount} of {candidates.length} ticked)
            </h3>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setPicked(new Set(visible.slice(0, MEMORY_IMPORT_MAX_ENTRIES).map((candidate) => candidate.sourceId)))}
              >
                Tick {visible.length > MEMORY_IMPORT_MAX_ENTRIES ? `first ${MEMORY_IMPORT_MAX_ENTRIES}` : "all"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                Untick all
              </Button>
            </div>
          </div>
          {check.isFetching ? <p className="text-xs text-muted-foreground">Checking what is already in memory...</p> : null}
          {matchedCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {matchedCount} {matchedCount === 1 ? "looks" : "look"} like {matchedCount === 1 ? "something" : "things"} memory already has, so{" "}
              {matchedCount === 1 ? "it starts" : "they start"} unticked.
            </p>
          ) : null}
          {check.error ? (
            <p className="text-xs text-muted-foreground">Could not check for repeats. Exact repeats are still skipped when you add.</p>
          ) : null}
          {candidates.length > 8 ? (
            <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search these" aria-label="Search" />
          ) : null}
          {atLimit ? (
            <p className="text-xs text-muted-foreground">
              You can add up to {MEMORY_IMPORT_MAX_ENTRIES} at a time. Add these, then come back for the rest: anything already added is skipped.
            </p>
          ) : null}
          <ul className="max-h-(--sz-memory-list-max) divide-y divide-border overflow-y-auto rounded-md border border-border">
            {visible.map((candidate) => {
              const on = picked.has(candidate.sourceId);
              return (
                <li key={candidate.sourceId} className="flex items-start gap-3 px-3 py-2">
                  <Checkbox
                    checked={on}
                    disabled={!on && atLimit}
                    onCheckedChange={(value) => toggle(candidate.sourceId, value === true)}
                    aria-label={candidate.title}
                    className="mt-1"
                  />
                  <div className="min-w-0 space-y-1 text-sm">
                    <p className="font-medium">{candidate.title}</p>
                    {matches?.get(candidate.sourceId) ? <MatchNote match={matches.get(candidate.sourceId)!} /> : null}
                    {candidate.messageCount !== null ? (
                      <p className="text-xs text-muted-foreground">
                        {candidate.occurredAt ? `${formatDate(candidate.occurredAt)}, ` : ""}
                        {candidate.messageCount} {candidate.messageCount === 1 ? "message" : "messages"}
                        {candidate.trimmed ? ", trimmed to the first part" : ""}
                      </p>
                    ) : null}
                    {candidate.messageCount !== null ? (
                      <p className="line-clamp-2 text-xs text-muted-foreground">{candidate.content}</p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {importMutation.error ? (
            <p className="text-sm text-destructive">
              {importMutation.error instanceof Error ? importMutation.error.message : "Could not add these. Try again."}
            </p>
          ) : null}
          {result ? <ImportSummary result={result} /> : null}
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">Added entries are labelled as brought in from {appLabel}.</p>
            <Button type="button" onClick={() => importMutation.mutate()} disabled={pickedCount === 0 || !scopeId || importMutation.isPending}>
              {importMutation.isPending ? "Adding..." : `Add ${pickedCount} to memory`}
            </Button>
          </div>
        </section>
      ) : method === "paste" && pasted.trim() ? (
        <p className="text-sm text-muted-foreground">Nothing to add yet. Paste the answer with one item per line.</p>
      ) : null}

      <MemoryConnectionsSection companyId={selectedCompanyId} />
    </div>
  );
}

function ImportSummary({ result }: { result: MemoryImportResult }) {
  const parts: string[] = [];
  if (result.added > 0) parts.push(`${result.added} added`);
  if (result.alreadyImported > 0) parts.push(`${result.alreadyImported} already in memory, skipped`);
  if (result.heldBack > 0) parts.push(`${result.heldBack} held back because they looked like personal or secret details`);
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm" role="status">
      <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
      <p>
        {parts.join(", ")}.{" "}
        {result.added > 0 ? (
          <>
            They are waiting in{" "}
            <Link to="/memory/review" className="underline underline-offset-2">
              Review
            </Link>{" "}
            until someone approves them.
          </>
        ) : null}
      </p>
    </div>
  );
}

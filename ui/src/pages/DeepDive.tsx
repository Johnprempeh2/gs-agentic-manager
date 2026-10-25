import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Microscope } from "lucide-react";
import {
  DEEP_DIVE_CASE_TYPES,
  DEEP_DIVE_DEPTHS,
  DEEP_DIVE_GIF,
  DEEP_DIVE_LABELS,
  DEEP_DIVE_RECORD_DOCUMENTS,
  DEEP_DIVE_RECORD_KEY,
  DEEP_DIVE_STREAM_STATUSES,
  DEEP_DIVE_STREAMS,
  DEEP_DIVE_VISIBILITIES,
  deepDiveGifStubBody,
  defaultDeepDiveStreamFields,
  readDeepDiveStreamFields,
  type DeepDiveKnowledge,
  type DeepDiveStreamFields,
} from "@greatstone/shared";
import { ApiError } from "@/api/client";
import { casesApi, type CaseDetail, type CaseSummary } from "@/api/cases";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link, useCaseHref, useNavigate } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { StatusBadge } from "@/components/StatusBadge";

type Stream = (typeof DEEP_DIVE_STREAMS)[number];
type RecordDocument = (typeof DEEP_DIVE_RECORD_DOCUMENTS)[number];

const TOTAL_CELLS = DEEP_DIVE_STREAMS.length * DEEP_DIVE_GIF.length;

/** Knowledge rides the existing status palette: green, amber, muted. */
const KNOWLEDGE_TONE: Record<DeepDiveKnowledge, string> = {
  known: "succeeded",
  indicated: "warning",
  unknown: "backlog",
};

const SELECT_CLASS =
  "h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-(length:--rad-3) focus-visible:ring-ring/50 disabled:text-subtle-foreground";

function deepDiveListQueryKey(companyId: string) {
  return [...queryKeys.cases.list(companyId), "deep-dive"] as const;
}

function listDeepDiveCases(companyId: string) {
  return casesApi.list(companyId, {
    types: [DEEP_DIVE_CASE_TYPES.record, DEEP_DIVE_CASE_TYPES.stream],
    limit: 200,
  });
}

function findCase(rows: readonly CaseSummary[], caseType: string, key: string) {
  return rows.find((row) => row.caseType === caseType && row.key === key) ?? null;
}

/** Lines of a document that are neither headings nor the stub's own prompt. */
function answerLines(body: string | null | undefined, prompt: string): string[] {
  return (body ?? "")
    .split("\n")
    .map((line) => line.trim().replace(/^[-*+]\s+/, ""))
    .filter((line) => line.length > 0 && !line.startsWith("#") && line !== prompt);
}

function documentBody(detail: CaseDetail | undefined, key: string) {
  return detail?.documents.find((entry) => entry.key === key)?.document.latestBody ?? null;
}

function hasDocument(detail: CaseDetail | undefined, key: string) {
  return detail?.documents.some((entry) => entry.key === key) ?? false;
}

/**
 * Create whatever part of the record is missing: the record case, the nine
 * stream cases and a stub for each missing GIF document. Reads the list
 * fresh, so running it again creates nothing new.
 */
export async function startDeepDiveRecord(companyId: string): Promise<void> {
  const rows = await listDeepDiveCases(companyId);
  const record =
    findCase(rows, DEEP_DIVE_CASE_TYPES.record, DEEP_DIVE_RECORD_KEY) ??
    (await casesApi.create(companyId, {
      caseType: DEEP_DIVE_CASE_TYPES.record,
      key: DEEP_DIVE_RECORD_KEY,
      title: "Deep dive record",
    }));
  for (const stream of DEEP_DIVE_STREAMS) {
    const existing = findCase(rows, DEEP_DIVE_CASE_TYPES.stream, stream.key);
    // ponytail: the create is an upsert that replaces fields, so it only runs for
    // a stream missing from the fresh list; a second tab racing within that
    // window would reset a brand new stream to the same defaults.
    const detail = existing
      ? await casesApi.get(existing.id)
      : await casesApi.create(companyId, {
          caseType: DEEP_DIVE_CASE_TYPES.stream,
          key: stream.key,
          title: `Deep dive: ${stream.label}`,
          parentCaseId: record.id,
          fields: { ...defaultDeepDiveStreamFields(stream.key) },
        });
    for (const gif of DEEP_DIVE_GIF) {
      if (hasDocument(detail, gif.documentKey)) continue;
      try {
        await casesApi.upsertDocument(detail.id, gif.documentKey, {
          title: gif.label,
          format: "markdown",
          body: deepDiveGifStubBody(gif),
        });
      } catch (error) {
        // 409: the document appeared meanwhile. It exists, which is all we need.
        if (!(error instanceof ApiError && error.status === 409)) throw error;
      }
    }
  }
}

function NorthStar({
  record,
  onAdd,
  adding,
}: {
  record: CaseDetail | undefined;
  onAdd: (document: RecordDocument) => void;
  adding: boolean;
}) {
  const caseHref = useCaseHref();
  const [northStar, ...others] = DEEP_DIVE_RECORD_DOCUMENTS;
  const words = answerLines(documentBody(record, northStar.key), northStar.prompt);

  function documentLink(document: RecordDocument, label: string = document.label) {
    if (record && hasDocument(record, document.key)) {
      return (
        <Link
          key={document.key}
          to={`${caseHref(record.identifier)}#document-${document.key}`}
          className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
        >
          {label}
        </Link>
      );
    }
    return (
      <Button
        key={document.key}
        type="button"
        variant="link"
        size="xs"
        className="px-0"
        disabled={!record || adding}
        onClick={() => onAdd(document)}
      >
        Add {document.label.toLowerCase()}
      </Button>
    );
  }

  return (
    <Card className="gap-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="deep-dive-north-star" className="text-sm font-semibold">
          North Star
        </h2>
        <div className="flex flex-wrap items-center gap-x-3">{others.map((document) => documentLink(document))}</div>
      </div>
      {words.length > 0 ? (
        <>
          <p className="line-clamp-3 text-sm">{words.join(" ")}</p>
          <div>{documentLink(northStar, "Open the North Star")}</div>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">Not recorded yet. {northStar.prompt}</p>
          {record && hasDocument(record, northStar.key) ? (
            documentLink(northStar, "Open the North Star")
          ) : (
            <Button type="button" size="sm" variant="outline" disabled={!record || adding} onClick={() => onAdd(northStar)}>
              Add the North Star
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function StreamRow({
  index,
  stream,
  row,
  detail,
  onSave,
  saving,
}: {
  index: number;
  stream: Stream;
  row: CaseSummary | null;
  detail: CaseDetail | undefined;
  /** Resolves true once saved; false when the save failed (the page shows the error). */
  onSave: (row: CaseSummary, fields: DeepDiveStreamFields) => Promise<boolean>;
  saving: boolean;
}) {
  const caseHref = useCaseHref();
  const fields = readDeepDiveStreamFields(stream.key, row?.fields);
  const [reasonDraft, setReasonDraft] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const headingId = `deep-dive-stream-${stream.key}`;
  const disabled = !row || saving;

  function save(patch: Partial<DeepDiveStreamFields>) {
    if (!row) return Promise.resolve(false);
    return onSave(row, { ...fields, ...patch });
  }

  function submitReason(event: FormEvent) {
    event.preventDefault();
    const reason = (reasonDraft ?? "").trim();
    if (!reason) {
      setReasonError("Name the reason. A stream is never dropped, only reduced with a named reason.");
      return;
    }
    void save({ depth: "reduced", depthReason: reason }).then((saved) => {
      if (!saved) return;
      setReasonDraft(null);
      setReasonError(null);
    });
  }

  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-border" data-deep-dive-stream={stream.key}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h3 id={headingId} className="text-sm font-semibold">
            {index + 1}. {stream.label}
          </h3>
          <p className="text-xs text-muted-foreground">{stream.conductedThrough}</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Status
            <select
              className={SELECT_CLASS}
              value={fields.status}
              disabled={disabled}
              onChange={(event) => void save({ status: event.target.value as DeepDiveStreamFields["status"] })}
            >
              {DEEP_DIVE_STREAM_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {DEEP_DIVE_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Depth
            <select
              className={SELECT_CLASS}
              value={reasonDraft !== null ? "reduced" : fields.depth}
              disabled={disabled}
              onChange={(event) => {
                if (event.target.value === "reduced") {
                  setReasonDraft(fields.depthReason);
                  setReasonError(null);
                  return;
                }
                setReasonDraft(null);
                setReasonError(null);
                if (fields.depth !== "full") void save({ depth: "full", depthReason: "" });
              }}
            >
              {DEEP_DIVE_DEPTHS.map((value) => (
                <option key={value} value={value}>
                  {DEEP_DIVE_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Visibility
            <select
              className={SELECT_CLASS}
              value={fields.visibility}
              disabled={disabled}
              onChange={(event) => void save({ visibility: event.target.value as DeepDiveStreamFields["visibility"] })}
            >
              {DEEP_DIVE_VISIBILITIES.map((value) => (
                <option key={value} value={value}>
                  {DEEP_DIVE_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {reasonDraft !== null ? (
        <form onSubmit={submitReason} className="space-y-1.5 border-b border-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={`Reason for reducing ${stream.label}`}
              aria-invalid={reasonError ? true : undefined}
              placeholder="Why is this stream reduced?"
              className="h-8 min-w-0 flex-1 basis-56"
              value={reasonDraft}
              onChange={(event) => setReasonDraft(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={saving}>
              Save reason
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setReasonDraft(null);
                setReasonError(null);
              }}
            >
              Cancel
            </Button>
          </div>
          {reasonError ? (
            <p role="alert" className="text-xs text-destructive">
              {reasonError}
            </p>
          ) : null}
        </form>
      ) : fields.depth === "reduced" ? (
        <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
          Reduced: {fields.depthReason || "no reason recorded"}
        </p>
      ) : null}

      <div className="grid grid-cols-1 divide-y divide-border lg:grid-cols-5 lg:divide-x lg:divide-y-0">
        {DEEP_DIVE_GIF.map((gif) => {
          const knowledge = fields.knowledge[gif.key];
          const firstLine = answerLines(documentBody(detail, gif.documentKey), gif.question)[0] ?? null;
          const content = (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground lg:sr-only">{gif.label}</span>
                <StatusBadge status={KNOWLEDGE_TONE[knowledge]} label={DEEP_DIVE_LABELS[knowledge]} />
              </div>
              <p className={cn("mt-1.5 line-clamp-2 text-sm", !firstLine && "text-muted-foreground")}>
                {firstLine ?? "No answer yet"}
              </p>
            </>
          );
          const cellProps = {
            "data-deep-dive-cell": `${stream.key}:${gif.key}`,
            "data-knowledge": knowledge,
          };
          return row ? (
            <Link
              key={gif.key}
              {...cellProps}
              to={`${caseHref(row.identifier)}#document-${gif.documentKey}`}
              title={gif.question}
              className="block min-w-0 px-3 py-2.5 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-(length:--rad-3) focus-visible:ring-inset focus-visible:ring-ring/50"
            >
              {content}
            </Link>
          ) : (
            <div key={gif.key} {...cellProps} className="min-w-0 px-3 py-2.5">
              {content}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function DeepDive() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const caseHref = useCaseHref();
  const startingRef = useRef(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Deep Dive" }]);
  }, [setBreadcrumbs]);

  const listQuery = useQuery({
    queryKey: deepDiveListQueryKey(selectedCompanyId ?? ""),
    queryFn: () => listDeepDiveCases(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const rows = useMemo(() => listQuery.data ?? [], [listQuery.data]);
  const recordRow = findCase(rows, DEEP_DIVE_CASE_TYPES.record, DEEP_DIVE_RECORD_KEY);
  const streamRows = DEEP_DIVE_STREAMS.map((stream) => findCase(rows, DEEP_DIVE_CASE_TYPES.stream, stream.key));
  const detailRows = [recordRow, ...streamRows].filter((row): row is CaseSummary => row !== null);

  const detailQueries = useQueries({
    queries: detailRows.map((row) => ({
      queryKey: queryKeys.cases.detail(row.identifier),
      queryFn: () => casesApi.get(row.identifier),
    })),
  });
  const detailById = new Map<string, CaseDetail>();
  for (const query of detailQueries) if (query.data) detailById.set(query.data.id, query.data);
  const recordDetail = recordRow ? detailById.get(recordRow.id) : undefined;

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.cases.list(selectedCompanyId ?? "") }),
      queryClient.invalidateQueries({ queryKey: ["cases", "detail"] }),
    ]);
  }

  const startMutation = useMutation({
    mutationFn: () => startDeepDiveRecord(selectedCompanyId!),
    onSettled: async () => {
      startingRef.current = false;
      await refresh();
    },
  });

  function start() {
    // A ref, not isPending: two fast presses land before the re-render.
    if (startingRef.current || !selectedCompanyId) return;
    startingRef.current = true;
    startMutation.mutate();
  }

  const saveMutation = useMutation({
    mutationFn: ({ row, fields }: { row: CaseSummary; fields: Record<string, unknown> }) =>
      casesApi.patch(row.id, { fields }),
    onMutate: ({ row, fields }) => {
      // Show the choice at once instead of snapping back until the refetch.
      queryClient.setQueryData<CaseSummary[]>(deepDiveListQueryKey(selectedCompanyId ?? ""), (current) =>
        current?.map((entry) => (entry.id === row.id ? { ...entry, fields } : entry)),
      );
    },
    onSettled: refresh,
  });

  function saveStream(row: CaseSummary, fields: DeepDiveStreamFields) {
    // Fields are written whole: keep any keys this page does not know about.
    return saveMutation.mutateAsync({ row, fields: { ...row.fields, ...fields } }).then(
      () => true,
      () => false,
    );
  }

  const addDocumentMutation = useMutation({
    mutationFn: async (document: RecordDocument) => {
      await casesApi.upsertDocument(recordRow!.id, document.key, {
        title: document.label,
        format: "markdown",
        body: `# ${document.label}\n\n${document.prompt}\n`,
      });
      return document;
    },
    onSuccess: async (document) => {
      await refresh();
      navigate(`${caseHref(recordRow!.identifier)}#document-${document.key}`);
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Microscope} message="Select a company to see its deep dive." />;
  }
  if (listQuery.isLoading) return <PageSkeleton variant="list" />;
  if (listQuery.error) {
    return (
      <p className="text-sm text-destructive">
        {listQuery.error instanceof Error ? listQuery.error.message : "Could not load the deep dive."}
      </p>
    );
  }

  const startError = startMutation.error instanceof Error ? startMutation.error.message : null;

  if (!recordRow) {
    return (
      <div className="space-y-3">
        <EmptyState
          icon={Microscope}
          title="No deep dive record yet"
          message="Start the record to lay out the nine Investigation Streams against the five GIF questions for this company. Every cell starts Unknown and every stream starts Internal."
          action={startMutation.isPending ? "Starting the record..." : "Start the deep dive record"}
          onAction={start}
          hideActionIcon
        />
        {startError ? (
          <p role="alert" className="text-center text-sm text-destructive">
            {startError}
          </p>
        ) : null}
      </div>
    );
  }

  const missingStreams = streamRows.filter((row) => row === null).length;
  const missingDocuments = streamRows.reduce((count, row) => {
    const detail = row ? detailById.get(row.id) : undefined;
    if (!detail) return count;
    return count + DEEP_DIVE_GIF.filter((gif) => !hasDocument(detail, gif.documentKey)).length;
  }, 0);

  const knowledgeCounts: Record<DeepDiveKnowledge, number> = { known: 0, indicated: 0, unknown: 0 };
  DEEP_DIVE_STREAMS.forEach((stream, index) => {
    const fields = readDeepDiveStreamFields(stream.key, streamRows[index]?.fields);
    for (const gif of DEEP_DIVE_GIF) knowledgeCounts[fields.knowledge[gif.key]] += 1;
  });
  const saveError = saveMutation.error instanceof Error ? saveMutation.error.message : null;
  const addError = addDocumentMutation.error instanceof Error ? addDocumentMutation.error.message : null;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-bold">Deep Dive</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          The nine Investigation Streams against the five GIF questions (Book V). Place the known, validate the
          indicated, investigate only the unknown. Open a cell to write its answer and attach the evidence.
        </p>
      </header>

      {missingStreams > 0 || missingDocuments > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
          <p className="text-sm text-muted-foreground">
            Part of the record is missing: {missingStreams} of 9 streams and {missingDocuments} GIF documents.
          </p>
          <Button type="button" size="sm" variant="outline" disabled={startMutation.isPending} onClick={start}>
            Complete the record
          </Button>
        </div>
      ) : null}
      {startError || saveError || addError ? (
        <p role="alert" className="text-sm text-destructive">
          {startError ?? saveError ?? addError}
        </p>
      ) : null}

      <NorthStar
        record={recordDetail}
        adding={addDocumentMutation.isPending}
        onAdd={(document) => addDocumentMutation.mutate(document)}
      />

      <div className="space-y-2">
        <div aria-hidden="true" className="hidden grid-cols-5 px-px lg:grid">
          {DEEP_DIVE_GIF.map((gif) => (
            <div key={gif.key} className="px-3" title={gif.question}>
              <p className="text-xs font-medium text-muted-foreground">{gif.label}</p>
            </div>
          ))}
        </div>
        {DEEP_DIVE_STREAMS.map((stream, index) => {
          const row = streamRows[index] ?? null;
          return (
            <StreamRow
              key={stream.key}
              index={index}
              stream={stream}
              row={row}
              detail={row ? detailById.get(row.id) : undefined}
              saving={saveMutation.isPending}
              onSave={saveStream}
            />
          );
        })}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border pt-3">
        <p className="text-sm" data-testid="deep-dive-coverage">
          <span className="font-medium">
            {knowledgeCounts.known} of {TOTAL_CELLS} cells known.
          </span>{" "}
          <span className="text-muted-foreground">
            {knowledgeCounts.indicated} indicated, {knowledgeCounts.unknown} unknown.
          </span>
        </p>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Coming next</span>
          <Button type="button" size="sm" variant="outline" disabled>
            Draft the agent team
          </Button>
        </div>
      </footer>
    </div>
  );
}

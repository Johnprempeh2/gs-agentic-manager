import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import {
  DEEP_DIVE_CASE_TYPES,
  DEEP_DIVE_FINDING_LABELS,
  DEEP_DIVE_GIF,
  DEEP_DIVE_LABELS,
  DEEP_DIVE_SESSION_LABELS,
  DEEP_DIVE_VISIBILITIES,
  currentDeepDiveSessionQuestion,
  deepDiveCellHasKnown,
  deepDiveSessionNextSteps,
  readDeepDiveStreamFields,
  type DeepDiveCellKnown,
  type DeepDiveGifKey,
  type DeepDiveKnowledge,
  type DeepDiveSession,
  type DeepDiveSessionQuestion,
  type DeepDiveSessionStatus,
  type DeepDiveStreamKey,
  type DeepDiveVisibility,
} from "@greatstone/shared";
import { casesApi } from "@/api/cases";
import { deepDiveFindingsQueryKeys } from "@/api/deepDiveFindings";
import { deepDiveSessionsApi, deepDiveSessionsQueryKeys } from "@/api/deepDiveSessions";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link, useNavigate, useParams } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { findingStreams } from "./DeepDiveFindings";

// Deep Dive sessions (GRE-2368): Screen 2 of the GRE-2327 plan, from the
// website's session run. Plan a session as questions in GIF cells, run it live
// one question at a time with what is already known beside it, and close it.
// An answer can become a proposed finding in the same cell.

const SESSION_TONE: Record<DeepDiveSessionStatus, string> = { planned: "pending", live: "running", closed: "archived" };
const KNOWLEDGE_TONE: Record<DeepDiveKnowledge, string> = { known: "succeeded", indicated: "warning", unknown: "archived" };
const GIF_LABEL = new Map(DEEP_DIVE_GIF.map((gif) => [gif.key, gif.label]));

const SELECT_CLASS =
  "h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-(length:--rad-3) focus-visible:ring-ring/50 disabled:text-subtle-foreground";

function errorText(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

/** The company's streams in Book V order, with each GIF cell's Known/Indicated/Unknown. */
function useStreams(companyId: string) {
  const query = useQuery({
    queryKey: [...queryKeys.cases.list(companyId), "deep-dive"],
    queryFn: () => casesApi.list(companyId, { types: [DEEP_DIVE_CASE_TYPES.record, DEEP_DIVE_CASE_TYPES.stream], limit: 200 }),
    enabled: !!companyId,
  });
  const streams = useMemo(
    () =>
      findingStreams(query.data ?? []).map((stream) => ({
        ...stream,
        knowledge: readDeepDiveStreamFields(stream.key as DeepDiveStreamKey, stream.row.fields).knowledge,
      })),
    [query.data],
  );
  return { query, streams };
}

type Streams = ReturnType<typeof useStreams>["streams"];

// ---------------------------------------------------------------------------
// The list: plan a session, open one.
// ---------------------------------------------------------------------------

export function DeepDiveSessions() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const companyId = selectedCompanyId ?? "";
  const [title, setTitle] = useState("");
  const [plannedFor, setPlannedFor] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Deep Dive", href: "/deep-dive" }, { label: "Sessions" }]);
  }, [setBreadcrumbs]);

  const listQuery = useQuery({
    queryKey: deepDiveSessionsQueryKeys.list(companyId),
    queryFn: () => deepDiveSessionsApi.list(companyId),
    enabled: !!selectedCompanyId,
  });
  const planMutation = useMutation({
    mutationFn: () =>
      deepDiveSessionsApi.plan(companyId, {
        title: title.trim(),
        plannedFor: plannedFor ? new Date(plannedFor).toISOString() : null,
      }),
    onSuccess: (session) => navigate(`/deep-dive/sessions/${session.id}`),
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={MessagesSquare} message="Select a company to see its sessions." />;
  }
  if (listQuery.isLoading) return <PageSkeleton variant="list" />;
  if (listQuery.error) return <p className="text-sm text-destructive">{errorText(listQuery.error)}</p>;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) {
      setFormError("Name the session.");
      return;
    }
    setFormError(null);
    planMutation.mutate();
  }

  const sessions = listQuery.data ?? [];
  const shownError = formError ?? errorText(planMutation.error);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-bold">Sessions</h1>
          <Link to="/deep-dive" className="text-xs font-medium underline-offset-4 hover:underline">
            Back to the Deep Dive
          </Link>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Plan a session as questions in the GIF cells of the Investigation Streams, then run it live one question at a
          time. What is already known shows beside each question, so nothing is asked twice. Every session starts
          Internal.
        </p>
      </header>

      <Card className="gap-3 px-4 py-3">
        <form onSubmit={submit} className="space-y-3" aria-labelledby="deep-dive-plan-session">
          <h2 id="deep-dive-plan-session" className="text-sm font-semibold">Plan a session</h2>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>What the session is for</span>
              <Input
                aria-invalid={formError ? true : undefined}
                placeholder="Interview with the operations lead"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>When (optional)</span>
              <Input type="datetime-local" value={plannedFor} onChange={(event) => setPlannedFor(event.target.value)} />
            </label>
          </div>
          {shownError ? (
            <p role="alert" className="text-xs text-destructive">
              {shownError}
            </p>
          ) : null}
          <Button type="submit" size="sm" disabled={planMutation.isPending}>
            {planMutation.isPending ? "Planning..." : "Plan session"}
          </Button>
        </form>
      </Card>

      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sessions yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {sessions.map((session) => (
            <li key={session.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
              <div className="min-w-0 space-y-0.5">
                <Link
                  to={`/deep-dive/sessions/${session.id}`}
                  className="block truncate text-sm font-medium underline-offset-4 hover:underline"
                >
                  {session.title}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {session.plannedFor ? `${formatDateTime(session.plannedFor)}, ` : ""}
                  {session.answeredCount} of {session.questionCount} answered
                </p>
              </div>
              <StatusBadge status={SESSION_TONE[session.status]} label={DEEP_DIVE_SESSION_LABELS[session.status]} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One session: plan its questions, run it live, read it back once closed.
// ---------------------------------------------------------------------------

/** What is already known about a question's GIF cell. */
export function KnownPanel({ known }: { known: DeepDiveCellKnown }) {
  const hasKnown = deepDiveCellHasKnown(known);
  return (
    <aside aria-label="Already known" className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold">Already known</h3>
        <StatusBadge status={KNOWLEDGE_TONE[known.knowledge]} label={DEEP_DIVE_LABELS[known.knowledge]} />
      </div>
      {!hasKnown ? (
        <p className="text-xs text-muted-foreground">Nothing yet. This is a gap worth asking about.</p>
      ) : null}
      {known.cellText ? (
        <p className="whitespace-pre-wrap text-xs text-foreground">{known.cellText}</p>
      ) : null}
      {known.findings.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Findings in this cell</p>
          <ul className="space-y-1">
            {known.findings.map((finding) => (
              <li key={finding.id} className="text-xs">
                <span className="text-muted-foreground">{DEEP_DIVE_FINDING_LABELS[finding.status]}:</span> {finding.statement}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {known.earlierAnswers.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Answered in other sessions</p>
          <ul className="space-y-1">
            {known.earlierAnswers.map((answer) => (
              <li key={answer.questionId} className="text-xs">
                <span className="text-muted-foreground">{answer.sessionTitle}:</span> {answer.answer}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </aside>
  );
}

function cellLabel(streams: Streams, question: DeepDiveSessionQuestion) {
  const stream = streams.find((entry) => entry.row.id === question.streamCaseId);
  return `${stream?.label ?? "Stream"} · ${GIF_LABEL.get(question.gifKey) ?? question.gifKey}`;
}

function AddQuestionForm({
  streams,
  defaultStreamCaseId,
  busy,
  onAdd,
}: {
  streams: Streams;
  /** The stream of the last question, so a plan within one stream needs no picking. */
  defaultStreamCaseId: string | null;
  busy: boolean;
  onAdd: (input: { streamCaseId: string; gifKey: DeepDiveGifKey; prompt?: string }) => void;
}) {
  const [streamCaseId, setStreamCaseId] = useState(defaultStreamCaseId ?? streams[0]?.row.id ?? "");
  const [gifKey, setGifKey] = useState<DeepDiveGifKey>(DEEP_DIVE_GIF[0].key);
  const [prompt, setPrompt] = useState("");
  const stream = streams.find((entry) => entry.row.id === streamCaseId) ?? streams[0];

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!stream) return;
    onAdd({ streamCaseId: stream.row.id, gifKey, ...(prompt.trim() ? { prompt: prompt.trim() } : {}) });
    setPrompt("");
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-labelledby="deep-dive-add-question">
      <h2 id="deep-dive-add-question" className="text-sm font-semibold">Add a question</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Investigation Stream</span>
          <NativeSelect value={stream?.row.id ?? ""} onChange={(event) => setStreamCaseId(event.target.value)}>
            {streams.map((entry) => (
              <option key={entry.key} value={entry.row.id}>
                {entry.label}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>GIF question</span>
          <NativeSelect value={gifKey} onChange={(event) => setGifKey(event.target.value as DeepDiveGifKey)}>
            {DEEP_DIVE_GIF.map((gif) => (
              <option key={gif.key} value={gif.key}>
                {gif.label} ({stream ? DEEP_DIVE_LABELS[stream.knowledge[gif.key]] : "Unknown"})
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>
      <label className="block space-y-1 text-xs text-muted-foreground">
        <span>Question (leave empty to ask the GIF question)</span>
        <Input
          placeholder={DEEP_DIVE_GIF.find((gif) => gif.key === gifKey)?.question}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <Button type="submit" size="sm" variant="outline" disabled={busy || !stream}>
        Add question
      </Button>
    </form>
  );
}

function FindingFromAnswer({
  question,
  busy,
  onPropose,
}: {
  question: DeepDiveSessionQuestion;
  busy: boolean;
  onPropose: (question: DeepDiveSessionQuestion, statement: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState(question.answer ?? "");
  if (question.findingId) {
    return (
      <Link to="/deep-dive/findings" className="text-xs font-medium underline-offset-4 hover:underline">
        Proposed as a finding
      </Link>
    );
  }
  if (!question.answer) return null;
  if (!open) {
    return (
      <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => setOpen(true)}>
        Turn into a finding
      </Button>
    );
  }
  return (
    <div className="w-full space-y-2">
      <label className="block space-y-1 text-xs text-muted-foreground">
        <span>Finding</span>
        <Textarea value={statement} onChange={(event) => setStatement(event.target.value)} />
      </label>
      <p className="text-xs text-muted-foreground">
        It is proposed in this question's stream and GIF cell, Internal, for a person to validate.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="xs"
          disabled={busy || !statement.trim()}
          onClick={() => onPropose(question, statement.trim())}
        >
          Propose finding
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Live: one question at a time, with what is known beside it. */
function LiveRun({
  session,
  streams,
  busy,
  onAnswer,
}: {
  session: DeepDiveSession;
  streams: Streams;
  busy: boolean;
  onAnswer: (question: DeepDiveSessionQuestion, answer: string) => Promise<unknown>;
}) {
  const ordered = session.questions;
  const firstOpen = currentDeepDiveSessionQuestion(ordered);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const current = ordered.find((question) => question.id === selectedId) ?? firstOpen ?? ordered[ordered.length - 1];
  const index = current ? ordered.findIndex((question) => question.id === current.id) : -1;
  const [draft, setDraft] = useState(current?.answer ?? "");

  useEffect(() => {
    setDraft(current?.answer ?? "");
  }, [current?.id, current?.answer]);

  if (!current) return null;
  const next = ordered[index + 1] ?? null;

  async function saveAndNext(event: FormEvent) {
    event.preventDefault();
    const saved = await onAnswer(current!, draft);
    if (saved) setSelectedId(next?.id ?? null);
  }

  return (
    <section aria-labelledby="deep-dive-live-question" className="space-y-3">
      <Card className="gap-3 px-4 py-3">
        <p className="text-xs text-muted-foreground">
          Question {index + 1} of {ordered.length} · {cellLabel(streams, current)}
          {!firstOpen ? " · every question has an answer" : ""}
        </p>
        <div className="grid gap-4 lg:grid-cols-5">
          <form onSubmit={saveAndNext} className="space-y-3 lg:col-span-3">
            <h2 id="deep-dive-live-question" className="text-base font-semibold">
              {current.prompt}
            </h2>
            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>Answer</span>
              <Textarea
                value={draft}
                disabled={!!current.findingId}
                placeholder="What did they say?"
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            {current.findingId ? (
              <p className="text-xs text-muted-foreground">This answer is a finding now, so it is kept as it was.</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" disabled={busy || !!current.findingId}>
                {next ? "Save and next" : "Save"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!next}
                onClick={() => setSelectedId(next?.id ?? null)}
              >
                Skip
              </Button>
            </div>
          </form>
          <div className="min-w-0 lg:col-span-2">
            <KnownPanel known={current.known} />
          </div>
        </div>
      </Card>
      <nav aria-label="All questions" className="flex flex-wrap gap-1.5">
        {ordered.map((question, position) => (
          <Button
            key={question.id}
            type="button"
            size="xs"
            variant={question.id === current.id ? "default" : "outline"}
            aria-current={question.id === current.id ? "step" : undefined}
            title={question.prompt}
            onClick={() => setSelectedId(question.id)}
          >
            {position + 1}
            {question.answer ? " ✓" : ""}
          </Button>
        ))}
      </nav>
    </section>
  );
}

export function DeepDiveSessionDetail() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { sessionId = "" } = useParams<{ sessionId: string }>();
  const companyId = selectedCompanyId ?? "";
  const { query: casesQuery, streams } = useStreams(companyId);

  const sessionQuery = useQuery({
    queryKey: deepDiveSessionsQueryKeys.detail(sessionId),
    queryFn: () => deepDiveSessionsApi.get(sessionId),
    enabled: !!sessionId,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Deep Dive", href: "/deep-dive" },
      { label: "Sessions", href: "/deep-dive/sessions" },
      { label: sessionQuery.data?.title ?? "Session" },
    ]);
  }, [setBreadcrumbs, sessionQuery.data?.title]);

  function keep(session: DeepDiveSession) {
    queryClient.setQueryData(deepDiveSessionsQueryKeys.detail(sessionId), session);
    void queryClient.invalidateQueries({ queryKey: deepDiveSessionsQueryKeys.list(companyId) });
  }

  const mutation = useMutation({
    mutationFn: (action: () => Promise<DeepDiveSession>) => action(),
    onSuccess: keep,
  });
  const findingMutation = useMutation({
    mutationFn: ({ question, statement }: { question: DeepDiveSessionQuestion; statement: string }) =>
      deepDiveSessionsApi.answerToFinding(question.id, statement === question.answer ? {} : { statement }),
    onSuccess: (result) => {
      keep(result.session);
      void queryClient.invalidateQueries({ queryKey: deepDiveFindingsQueryKeys.list(companyId) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={MessagesSquare} message="Select a company to see its sessions." />;
  }
  if (sessionQuery.isLoading || casesQuery.isLoading) return <PageSkeleton variant="list" />;
  const loadError = errorText(sessionQuery.error) ?? errorText(casesQuery.error);
  if (loadError) return <p className="text-sm text-destructive">{loadError}</p>;
  const session = sessionQuery.data;
  if (!session) return null;

  const steps = deepDiveSessionNextSteps(session.status);
  const busy = mutation.isPending || findingMutation.isPending;
  const actionError = errorText(mutation.error) ?? errorText(findingMutation.error);
  const run = (action: () => Promise<DeepDiveSession>) => mutation.mutateAsync(action).catch(() => undefined);

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-bold">{session.title}</h1>
          <Link to="/deep-dive/sessions" className="text-xs font-medium underline-offset-4 hover:underline">
            All sessions
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={SESSION_TONE[session.status]} label={DEEP_DIVE_SESSION_LABELS[session.status]} />
          <span className="text-xs text-muted-foreground">
            {session.plannedFor ? `${formatDateTime(session.plannedFor)} · ` : ""}
            {session.answeredCount} of {session.questionCount} answered
          </span>
          <select
            aria-label="Visibility"
            className={SELECT_CLASS}
            value={session.visibility}
            disabled={busy}
            onChange={(event) =>
              run(() => deepDiveSessionsApi.update(session.id, { visibility: event.target.value as DeepDiveVisibility }))
            }
          >
            {DEEP_DIVE_VISIBILITIES.map((value) => (
              <option key={value} value={value}>
                {DEEP_DIVE_LABELS[value]}
              </option>
            ))}
          </select>
          {steps.start ? (
            <Button
              type="button"
              size="sm"
              disabled={busy || session.questions.length === 0}
              onClick={() => run(() => deepDiveSessionsApi.start(session.id))}
            >
              Start session
            </Button>
          ) : null}
          {steps.close ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => run(() => deepDiveSessionsApi.close(session.id))}>
              Close session
            </Button>
          ) : null}
        </div>
        {steps.start && session.questions.length === 0 ? (
          <p className="text-xs text-muted-foreground">Add at least one question, then start the session.</p>
        ) : null}
      </header>

      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      {streams.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title="No Investigation Streams yet"
          message="Start the deep dive record first. Every question sits in one GIF cell of a stream."
        />
      ) : null}

      {session.status === "live" && session.questions.length > 0 ? (
        <LiveRun
          session={session}
          streams={streams}
          busy={busy}
          onAnswer={(question, answer) =>
            run(() => deepDiveSessionsApi.updateQuestion(question.id, { answer: answer.trim() ? answer : null }))
          }
        />
      ) : null}

      {steps.addQuestion && streams.length > 0 ? (
        <Card className="gap-3 px-4 py-3">
          <AddQuestionForm
            streams={streams}
            defaultStreamCaseId={session.questions[session.questions.length - 1]?.streamCaseId ?? null}
            busy={busy}
            onAdd={(input) => run(() => deepDiveSessionsApi.addQuestion(session.id, input))}
          />
        </Card>
      ) : null}

      {session.questions.length > 0 ? (
        <section aria-labelledby="deep-dive-session-questions" className="rounded-lg border border-border">
          <h2 id="deep-dive-session-questions" className="border-b border-border px-3 py-2 text-sm font-semibold">
            {session.status === "planned" ? "The plan" : "Questions and answers"}
          </h2>
          <ol className="divide-y divide-border">
            {session.questions.map((question, position) => (
              <li key={question.id} className="space-y-2 px-3 py-2.5" data-deep-dive-question={question.id}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-xs text-muted-foreground">
                      {position + 1}. {cellLabel(streams, question)}
                    </p>
                    <p className="text-sm font-medium">{question.prompt}</p>
                  </div>
                  {steps.removeQuestion ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => run(() => deepDiveSessionsApi.removeQuestion(question.id))}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
                {session.status === "planned" ? (
                  <KnownPanel known={question.known} />
                ) : (
                  <>
                    <p className={question.answer ? "whitespace-pre-wrap text-sm" : "text-sm text-muted-foreground"}>
                      {question.answer ?? "Not answered"}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <FindingFromAnswer
                        question={question}
                        busy={busy}
                        onPropose={(target, statement) => findingMutation.mutate({ question: target, statement })}
                      />
                    </div>
                  </>
                )}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

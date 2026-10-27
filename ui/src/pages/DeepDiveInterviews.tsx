import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import {
  DEEP_DIVE_GIF,
  DEEP_DIVE_INTERVIEW_CONTEXT_FIELDS,
  DEEP_DIVE_INTERVIEW_DEFAULT_MINUTES,
  DEEP_DIVE_INTERVIEW_LABELS,
  DEEP_DIVE_STREAMS,
  deepDiveInterviewReadiness,
  websiteOrganisationIdSchema,
  type DeepDiveInterviewContextPack,
  type DeepDiveInterviewMode,
  type DeepDiveInterviewQuestion,
  type DeepDiveInterviewRound,
  type DeepDiveInterviewRoundView,
  type DeepDiveInterviewSet,
} from "@greatstone/shared";
import { deepDiveInterviewsApi, deepDiveInterviewsQueryKeys } from "@/api/deepDiveInterviews";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link } from "@/lib/router";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { RadioCard } from "@/components/ui/radio-card";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { InterviewInvites } from "./DeepDiveInterviewInvites";
import { InterviewReview } from "./DeepDiveInterviewReview";

// Parallel Interview (GRE-2611): the Deep Dive's first step. Set up the one
// round (per team or per person, about 20 minutes, Everest's context pack),
// draft a question set for each team or person from what the Deep Dive
// already knows, and approve each set. Invites go out from the website only
// after every set is approved (GRE-2665, DeepDiveInterviewInvites). Once the
// round is open, a person reviews the agent's synthesis and releases it
// (GRE-2756, DeepDiveInterviewReview).

const SET_TONE = { draft: "pending", approved: "succeeded" } as const;
const ROUND_TONE = { setup: "pending", open: "running", closed: "archived" } as const;
const STREAM_LABEL = new Map<string, string>(DEEP_DIVE_STREAMS.map((stream) => [stream.key, stream.label]));
const GIF_LABEL = new Map<string, string>(DEEP_DIVE_GIF.map((gif) => [gif.key, gif.label]));

const MODE_OPTIONS: { value: DeepDiveInterviewMode; title: string; description: string }[] = [
  { value: "per_team", title: "Per team", description: "A large organisation: one question set for each team." },
  { value: "per_person", title: "Per person", description: "A small organisation: one question set for each person." },
];

function errorText(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

function cellLabel(question: Pick<DeepDiveInterviewQuestion, "streamKey" | "gifKey">) {
  if (!question.streamKey || !question.gifKey) return "Your own question";
  return `${STREAM_LABEL.get(question.streamKey) ?? question.streamKey}: ${GIF_LABEL.get(question.gifKey) ?? question.gifKey}`;
}

function useRoundWrite<TInput>(companyId: string, fn: (input: TInput) => Promise<DeepDiveInterviewRoundView>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (view) => queryClient.setQueryData(deepDiveInterviewsQueryKeys.round(companyId), view),
  });
}

function ContextFields({
  value,
  onChange,
  disabled,
}: {
  value: DeepDiveInterviewContextPack;
  onChange: (next: DeepDiveInterviewContextPack) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {DEEP_DIVE_INTERVIEW_CONTEXT_FIELDS.map((field) => (
        <label key={field.key} className="space-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{field.label}</span>
          <span className="block">{field.hint}</span>
          <Textarea
            rows={3}
            disabled={disabled}
            value={value[field.key] ?? ""}
            onChange={(event) => onChange({ ...value, [field.key]: event.target.value })}
          />
        </label>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Before the round exists: set it up.
// ---------------------------------------------------------------------------

function SetUpRound({ companyId }: { companyId: string }) {
  const [organisationId, setOrganisationId] = useState("");
  const [mode, setMode] = useState<DeepDiveInterviewMode>("per_team");
  const [minutes, setMinutes] = useState(String(DEEP_DIVE_INTERVIEW_DEFAULT_MINUTES));
  const [context, setContext] = useState<DeepDiveInterviewContextPack>({});
  const [formError, setFormError] = useState<string | null>(null);
  const create = useRoundWrite(companyId, () =>
    deepDiveInterviewsApi.create(companyId, {
      websiteOrganisationId: organisationId.trim(),
      mode,
      targetMinutes: Number(minutes),
      contextPack: context,
    }),
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!websiteOrganisationIdSchema.safeParse(organisationId).success) {
      setFormError("Enter the client's website organisation id. The round and every invite are keyed by it.");
      return;
    }
    const value = Number(minutes);
    if (!Number.isInteger(value) || value < 5 || value > 90) {
      setFormError("Give a target length of 5 to 90 minutes.");
      return;
    }
    setFormError(null);
    create.mutate(undefined);
  }

  const shownError = formError ?? errorText(create.error);
  return (
    <Card className="gap-3 px-4 py-3">
      <form onSubmit={submit} noValidate className="space-y-4" aria-labelledby="interview-set-up">
        <h2 id="interview-set-up" className="text-sm font-semibold">Set up the round</h2>
        <label className="block max-w-sm space-y-1 text-xs text-muted-foreground">
          <span>Website organisation id</span>
          <Input
            autoComplete="off"
            spellCheck={false}
            aria-invalid={formError ? true : undefined}
            value={organisationId}
            onChange={(event) => setOrganisationId(event.target.value)}
          />
          <span className="block">The client's one id on the website. It cannot change once the round is set up.</span>
        </label>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Who each question set is for">
          {MODE_OPTIONS.map((option) => (
            <RadioCard
              key={option.value}
              type="button"
              selected={mode === option.value}
              title={option.title}
              description={option.description}
              onClick={() => setMode(option.value)}
            />
          ))}
        </div>
        <label className="block max-w-48 space-y-1 text-xs text-muted-foreground">
          <span>Target length (minutes)</span>
          <Input
            type="number"
            min={5}
            max={90}
            inputMode="numeric"
            aria-invalid={formError ? true : undefined}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </label>
        <div className="space-y-2">
          <h3 className="text-xs font-semibold">Context pack</h3>
          <p className="text-xs text-muted-foreground">
            What the interviewer knows before it starts. Same fields as Everest, so the website reads them unchanged.
          </p>
          <ContextFields value={context} onChange={setContext} />
        </div>
        {shownError ? (
          <p role="alert" className="text-xs text-destructive">
            {shownError}
          </p>
        ) : null}
        <Button type="submit" size="sm" disabled={create.isPending}>
          {create.isPending ? "Setting up..." : "Set up the round"}
        </Button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The round: its setup and one question set per team or person.
// ---------------------------------------------------------------------------

function RoundSetup({ round, companyId }: { round: DeepDiveInterviewRound; companyId: string }) {
  const editable = round.status === "setup";
  const [editing, setEditing] = useState(false);
  const [minutes, setMinutes] = useState(String(round.targetMinutes));
  const [context, setContext] = useState<DeepDiveInterviewContextPack>(round.contextPack);
  const save = useRoundWrite(companyId, () =>
    deepDiveInterviewsApi.update(round.id, { targetMinutes: Number(minutes), contextPack: context }),
  );
  const readiness = deepDiveInterviewReadiness(round);
  const filled = DEEP_DIVE_INTERVIEW_CONTEXT_FIELDS.filter((field) => round.contextPack[field.key]?.trim());

  return (
    <Card className="gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {DEEP_DIVE_INTERVIEW_LABELS[round.mode]}, about {round.targetMinutes} minutes
        </h2>
        <StatusBadge status={ROUND_TONE[round.status]} label={DEEP_DIVE_INTERVIEW_LABELS[round.status]} />
      </div>
      <p className="text-xs text-muted-foreground">
        Website organisation <span className="font-mono text-foreground">{round.websiteOrganisationId}</span>
      </p>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {readiness.total === 0
          ? `No question sets yet. Draft one for each ${round.mode === "per_team" ? "team" : "person"} below.`
          : readiness.ready
            ? `All ${readiness.total} question sets are approved. Invites can go out.`
            : `${readiness.approved} of ${readiness.total} question sets approved. Invites go out only when a person has approved every set.`}
      </p>
      {editing ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(undefined, { onSuccess: () => setEditing(false) });
          }}
        >
          <label className="block max-w-48 space-y-1 text-xs text-muted-foreground">
            <span>Target length (minutes)</span>
            <Input type="number" min={5} max={90} inputMode="numeric" value={minutes} onChange={(event) => setMinutes(event.target.value)} />
          </label>
          <ContextFields value={context} onChange={setContext} />
          {save.error ? <p role="alert" className="text-xs text-destructive">{errorText(save.error)}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={save.isPending}>{save.isPending ? "Saving..." : "Save"}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="space-y-2">
          {filled.length === 0 ? (
            <p className="text-xs text-muted-foreground">The context pack is empty.</p>
          ) : (
            <dl className="grid gap-2 text-xs md:grid-cols-2">
              {filled.map((field) => (
                <div key={field.key} className="min-w-0">
                  <dt className="font-medium">{field.label}</dt>
                  <dd className="whitespace-pre-wrap break-words text-muted-foreground">{round.contextPack[field.key]}</dd>
                </div>
              ))}
            </dl>
          )}
          {editable ? (
            <Button type="button" size="xs" variant="outline" onClick={() => setEditing(true)}>
              Edit setup
            </Button>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function QuestionSetCard({ set, companyId, editable }: { set: DeepDiveInterviewSet; companyId: string; editable: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DeepDiveInterviewQuestion[]>(set.questions);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const approve = useRoundWrite(companyId, () => deepDiveInterviewsApi.approveSet(set.id));
  const redraft = useRoundWrite(companyId, () => deepDiveInterviewsApi.redraftSet(set.id));
  const remove = useRoundWrite(companyId, () => deepDiveInterviewsApi.removeSet(set.id));
  const save = useRoundWrite(companyId, (questions: DeepDiveInterviewQuestion[]) =>
    deepDiveInterviewsApi.updateSet(set.id, { questions }),
  );
  const error = [approve, redraft, remove, save].map((m) => errorText(m.error)).find(Boolean) ?? null;
  const busy = approve.isPending || redraft.isPending || remove.isPending || save.isPending;

  useEffect(() => {
    if (!editing) setDraft(set.questions);
  }, [editing, set.questions]);

  const headingId = `interview-set-${set.id}`;
  return (
    <Card className="gap-3 px-4 py-3" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={headingId} className="break-words text-sm font-semibold">{set.target.name}</h3>
          {set.target.detail ? <p className="text-xs text-muted-foreground">{set.target.detail}</p> : null}
        </div>
        <StatusBadge status={SET_TONE[set.status]} label={DEEP_DIVE_INTERVIEW_LABELS[set.status]} />
      </div>

      {set.known.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium">Already known, not asked ({set.known.length})</summary>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            {set.known.map((item) => (
              <li key={`${item.streamKey}-${item.gifKey}`} className="break-words">
                <span className="font-medium text-foreground">{cellLabel(item)}.</span> {item.text}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {editing ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(draft.map((q) => ({ ...q, prompt: q.prompt.trim() })).filter((q) => q.prompt), {
              onSuccess: () => setEditing(false),
            });
          }}
        >
          <ol className="space-y-3">
            {draft.map((question, index) => (
              <li key={index} className="space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{index + 1}. {DEEP_DIVE_INTERVIEW_LABELS[question.purpose]}, {cellLabel(question)}</span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => setDraft(draft.filter((_, i) => i !== index))}
                    aria-label={`Remove question ${index + 1}`}
                  >
                    Remove
                  </Button>
                </div>
                <Textarea
                  rows={2}
                  aria-label={`Question ${index + 1}`}
                  value={question.prompt}
                  onChange={(event) => setDraft(draft.map((q, i) => (i === index ? { ...q, prompt: event.target.value } : q)))}
                />
              </li>
            ))}
          </ol>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => setDraft([...draft, { prompt: "", purpose: "investigate", streamKey: null, gifKey: null }])}
          >
            Add a question
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy || draft.every((q) => !q.prompt.trim())}>
              {save.isPending ? "Saving..." : "Save questions"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
          {set.status === "approved" ? (
            <p className="text-xs text-muted-foreground">Saving puts the set back to Draft for a person to approve again.</p>
          ) : null}
        </form>
      ) : (
        <ol className="space-y-2">
          {set.questions.map((question, index) => (
            <li key={index} className="space-y-0.5">
              <p className="break-words text-sm">{index + 1}. {question.prompt}</p>
              <p className="text-xs text-muted-foreground">
                {DEEP_DIVE_INTERVIEW_LABELS[question.purpose]}, {cellLabel(question)}
              </p>
            </li>
          ))}
        </ol>
      )}

      <p className="text-xs text-muted-foreground">
        {set.questions.length} questions
        {set.leftOut > 0 ? `; ${set.leftOut} more unknown cells left out to keep near the target length` : ""}.
        {set.approvedAt ? ` Approved ${formatDateTime(set.approvedAt)}.` : ""}
      </p>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}

      {editable && !editing ? (
        <div className="flex flex-wrap gap-2">
          {set.status === "draft" ? (
            <Button type="button" size="sm" disabled={busy} onClick={() => approve.mutate(undefined)}>
              {approve.isPending ? "Approving..." : "Approve questions"}
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => redraft.mutate(undefined)}>
            {redraft.isPending ? "Drafting..." : "Draft again"}
          </Button>
          {confirmRemove ? (
            <>
              <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => remove.mutate(undefined)}>
                Remove this set
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>Keep</Button>
            </>
          ) : (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmRemove(true)}>
              Remove
            </Button>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function QuestionSets({ view, companyId }: { view: DeepDiveInterviewRoundView & { round: DeepDiveInterviewRound }; companyId: string }) {
  const { round, available } = view;
  const editable = round.status === "setup";
  const [targetId, setTargetId] = useState("");
  const chosen = available.find((target) => target.id === targetId) ?? available[0] ?? null;
  const draft = useRoundWrite(companyId, () =>
    deepDiveInterviewsApi.draftSet(round.id, chosen!.kind === "unit" ? { unitId: chosen!.id } : { personId: chosen!.id }),
  );
  const noun = round.mode === "per_team" ? "team" : "person";

  return (
    <section className="space-y-3" aria-labelledby="interview-sets">
      <h2 id="interview-sets" className="text-sm font-semibold">Question sets</h2>
      {editable ? (
        <Card className="gap-2 px-4 py-3">
          {available.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {round.sets.length === 0
                ? `No ${noun === "team" ? "teams" : "client people"} on the organisation board yet. `
                : `Every ${noun} on the organisation board has a question set. `}
              <Link to="/deep-dive/organisation" className="underline">Open the organisation board</Link>.
            </p>
          ) : (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (chosen) draft.mutate(undefined, { onSuccess: () => setTargetId("") });
              }}
            >
              <label className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">
                <span>Draft questions for a {noun}</span>
                <NativeSelect value={chosen?.id ?? ""} onChange={(event) => setTargetId(event.target.value)}>
                  {available.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.name}{target.detail ? `, ${target.detail}` : ""}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <Button type="submit" size="sm" disabled={draft.isPending}>
                {draft.isPending ? "Drafting..." : "Draft questions"}
              </Button>
            </form>
          )}
          <p className="text-xs text-muted-foreground">
            Drafted from what the Deep Dive knows now: Known cells are told to the interviewer and never asked, Indicated
            cells are checked, Unknown cells are explored.
          </p>
          {draft.error ? <p role="alert" className="text-xs text-destructive">{errorText(draft.error)}</p> : null}
        </Card>
      ) : null}
      {round.sets.map((set) => (
        <QuestionSetCard key={`${set.id}-${set.updatedAt}`} set={set} companyId={companyId} editable={editable} />
      ))}
    </section>
  );
}

export function DeepDiveInterviews() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const companyId = selectedCompanyId ?? "";

  useEffect(() => {
    setBreadcrumbs([{ label: "Deep Dive", href: "/deep-dive" }, { label: "Parallel Interview" }]);
  }, [setBreadcrumbs]);

  const query = useQuery({
    queryKey: deepDiveInterviewsQueryKeys.round(companyId),
    queryFn: () => deepDiveInterviewsApi.get(companyId),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) return <EmptyState icon={Users} message="Select a company to see its Parallel Interview." />;
  if (query.isLoading) return <PageSkeleton variant="list" />;
  if (query.error) return <p className="text-sm text-destructive">{errorText(query.error)}</p>;
  const view = query.data!;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-bold">Parallel Interview</h1>
          <Link to="/deep-dive" className="text-xs font-medium underline-offset-4 hover:underline">
            Back to the Deep Dive
          </Link>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          The Deep Dive's first step: one round for this engagement, about 20 minutes with each team or person, taken on
          the website. Each set of questions builds on what we already know, and a person approves it before any invite
          goes out.
        </p>
      </header>
      {view.round ? (
        <>
          <RoundSetup key={view.round.updatedAt} round={view.round} companyId={companyId} />
          <QuestionSets view={view as DeepDiveInterviewRoundView & { round: DeepDiveInterviewRound }} companyId={companyId} />
          <InterviewInvites round={view.round} companyId={companyId} />
          {view.round.status !== "setup" ? <InterviewReview round={view.round} companyId={companyId} /> : null}
        </>
      ) : (
        <SetUpRound companyId={companyId} />
      )}
    </div>
  );
}

import { useEffect } from "react";
import { Award, CheckCircle2, Circle, ShieldCheck, ShieldX } from "lucide-react";
import type { QuestState } from "@/api/onboarding";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useConfirm } from "@/context/ConfirmContext";
import { useOnboardingQuest } from "@/hooks/useOnboardingQuest";
import { showMeHref } from "@/lib/onboarding-quest";
import { Link, useSearchParams } from "@/lib/router";
import { cn } from "@/lib/utils";

const timeFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The bar and the chapter badges: shared by the quest page and the owner's view of a member. */
export function QuestProgressSummary({ state, who = "you" }: { state: QuestState; who?: string }) {
  const percent = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span className="font-medium text-foreground">
            {state.finishedAt ? "Finished" : state.startedAt ? `${state.done} of ${state.total} steps` : `Not started by ${who}`}
          </span>
          <span className="text-muted-foreground">{percent}%</span>
        </div>
        <div
          role="progressbar"
          aria-label="Getting started progress"
          aria-valuemin={0}
          aria-valuemax={state.total}
          aria-valuenow={state.done}
          className="h-2 overflow-hidden rounded-full bg-track"
        >
          <div className="h-full rounded-full bg-primary motion-safe:transition-[width] motion-safe:duration-500" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <ul className="flex flex-wrap gap-2" aria-label="Chapter badges">
        {state.chapters.map((chapter) => (
          <li
            key={chapter.key}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
              chapter.badge ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground",
            )}
          >
            <Award className="size-3.5" aria-hidden="true" />
            {chapter.title}
            <span className="sr-only">{chapter.badge ? ", badge earned" : chapter.skipped ? ", skipped" : ", not yet"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ControlPanel({ state }: { state: QuestState }) {
  const ask = state.control.askFirst;
  return (
    <div id="what-you-control" className="space-y-4 rounded-lg border border-border bg-card p-4" data-tour="quest-control">
      <p className="text-sm text-foreground">
        You are {/^[AEIOU]/.test(state.roleLabel) ? "an" : "a"} <strong>{state.roleLabel}</strong>. This list is worked out from your real access, so it changes when your access does.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <section aria-label="You can">
          <h3 className="mb-2 text-sm font-semibold text-foreground">You can</h3>
          <ul className="space-y-1.5">
            {state.control.can.map((line) => (
              <li key={line.key} className="flex gap-2 text-sm text-foreground">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />{line.text}
              </li>
            ))}
          </ul>
        </section>
        <section aria-label="You cannot">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Not yours to do</h3>
          {state.control.cannot.length ? (
            <ul className="space-y-1.5">
              {state.control.cannot.map((line) => (
                <li key={line.key} className="flex gap-2 text-sm text-muted-foreground">
                  <ShieldX className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{line.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing: you hold every right on this list.</p>
          )}
        </section>
      </div>
      <p className="text-sm text-foreground">
        {ask.length
          ? <>For anything you cannot do, ask {ask.map((person, index) => (
              <span key={person.name + index}>{index > 0 ? (index === ask.length - 1 ? " or " : ", ") : ""}<strong>{person.name}</strong> ({person.role})</span>
            ))}. Message them, or leave a comment on the task and name them.</>
          : "You are the only owner or admin, so the final say on everything here is yours."}
      </p>
    </div>
  );
}

/**
 * Getting started: the quest log. Each step ticks itself when the person does
 * the real thing; "Show me" opens the place and points at it.
 */
export function GettingStarted() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const { state, isLoading, isError, start, skip, clearPractice, replay } = useOnboardingQuest();
  const controlOpen = searchParams.get("section") === "control";

  useEffect(() => { setBreadcrumbs([{ label: "Getting started" }]); }, [setBreadcrumbs]);

  if (isLoading) return <p className="p-6 text-sm text-muted-foreground">Loading Getting started…</p>;
  if (isError || !state) return <p className="p-6 text-sm text-muted-foreground">Getting started is not available for this company.</p>;

  const toggleControl = () => setSearchParams((params) => {
    if (controlOpen) params.delete("section"); else params.set("section", "control");
    return params;
  }, { replace: true });

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 md:px-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">Getting started</h1>
        <p className="text-sm text-muted-foreground">
          Learn GSAM by doing the real thing. Each step ticks itself when you do it, and "Show me" takes you there and points the way.
        </p>
      </header>

      {!state.startedAt ? (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <p className="text-sm text-foreground">
            {state.chapters.length} short chapters. We make you a practice task that only you can see, so nothing you try touches real work, the agents or the website.
          </p>
          <Button onClick={() => start.mutate()} disabled={start.isPending}>Start Getting started</Button>
        </div>
      ) : (
        <QuestProgressSummary state={state} />
      )}

      {state.finishedAt ? (
        <p className="rounded-lg border border-primary bg-card p-4 text-sm text-foreground">
          All done. You finished on {timeFormat.format(new Date(state.finishedAt))}. Your practice items are archived.
        </p>
      ) : null}

      <ol className="space-y-4">
        {state.chapters.map((chapter, chapterIndex) => {
          const done = chapter.steps.filter((step) => step.doneAt).length;
          return (
            <li key={chapter.key} className="rounded-lg border border-border bg-card p-4" aria-labelledby={`quest-${chapter.key}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-xs text-muted-foreground">Chapter {chapterIndex + 1}</p>
                  <h2 id={`quest-${chapter.key}`} className="flex items-center gap-2 text-base font-semibold text-foreground">
                    {chapter.title}
                    {chapter.badge ? <Award className="size-4 text-primary" aria-label="Badge earned" /> : null}
                  </h2>
                  <p className="text-sm text-muted-foreground">{chapter.summary}</p>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">{chapter.skipped ? "Skipped" : `${done} of ${chapter.steps.length}`}</span>
                  {state.startedAt && !chapter.badge && !state.finishedAt ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => skip.mutate({ chapter: chapter.key, skipped: !chapter.skipped })}
                      disabled={skip.isPending}
                    >
                      {chapter.skipped ? "Bring back" : "Skip chapter"}
                    </Button>
                  ) : null}
                </div>
              </div>
              {chapter.skipped ? null : (
                <ul className="mt-3 divide-y divide-border">
                  {chapter.steps.map((step) => {
                    const href = state.startedAt ? showMeHref(step, state.practiceIssueId) : null;
                    const isControl = step.key === "read-control";
                    return (
                      <li key={step.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex gap-3">
                          {step.doneAt
                            ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-primary" aria-label="Done" />
                            : <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-label="Not done yet" />}
                          <div>
                            <p className="text-sm font-medium text-foreground">{step.title}</p>
                            <p className="text-sm text-muted-foreground">{step.body}</p>
                            {step.doneAt ? <p className="text-xs text-muted-foreground">Done {timeFormat.format(new Date(step.doneAt))}</p> : null}
                          </div>
                        </div>
                        {isControl && state.startedAt ? (
                          <Button size="sm" variant="outline" className="min-h-11 shrink-0 sm:min-h-8" onClick={toggleControl} aria-expanded={controlOpen}>
                            {controlOpen ? "Hide What you control" : "Open What you control"}
                          </Button>
                        ) : href && !step.doneAt ? (
                          <Button size="sm" variant="outline" className="min-h-11 shrink-0 sm:min-h-8" asChild>
                            <Link to={href} aria-label={`Show me: ${step.title}`}>Show me</Link>
                          </Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
              {chapter.key === "what-you-control" && (controlOpen || !state.startedAt || chapter.badge) ? <ControlPanel state={state} /> : null}
            </li>
          );
        })}
      </ol>

      {state.startedAt ? (
        <footer className="flex flex-wrap gap-2 border-t border-border pt-4">
          {state.practiceIssueId && !state.practiceArchived ? (
            <Button variant="outline" onClick={() => clearPractice.mutate()} disabled={clearPractice.isPending}>
              Clear my practice items
            </Button>
          ) : null}
          <Button
            variant="ghost"
            disabled={replay.isPending}
            onClick={async () => {
              const ok = await confirm({
                title: "Start Getting started again?",
                description: "Your ticks are cleared, your old practice items are archived and you get a fresh practice task. Your real work is not touched.",
                confirmLabel: "Start again",
              });
              if (ok) replay.mutate();
            }}
          >
            Start again
          </Button>
        </footer>
      ) : null}
    </div>
  );
}

export default GettingStarted;

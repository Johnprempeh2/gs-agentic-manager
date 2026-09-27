import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, AudioLines, Loader2, Mic, Pause, Play } from "lucide-react";
import type { Agent, AskUserQuestionsQuestion, AttentionItem, IssueThreadInteraction } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { isIssueThreadInteraction } from "../../lib/issue-thread-interactions";
import { hasBlockingShortcutDialog, isKeyboardShortcutTextInputTarget } from "../../lib/keyboardShortcuts";
import { focusItemIssueId, focusNativeQuestion, focusSpeechContent } from "../../lib/focus-items";
import { buildSpokenSummary, parseOptionCommand, splitSentences, plainTextFromMarkdown, type SpokenPart } from "../../lib/focus-speech";
import { FOCUS_SPEEDS, nextFocusSpeed, type FocusPrefs } from "../../lib/focus-prefs";
import { cn, relativeTime } from "../../lib/utils";
import { useSpeechReader } from "../../hooks/useSpeechReader";
import { useDictation } from "../../hooks/useDictation";
import { AgentAvatar } from "../AgentAvatar";
import { AttentionInteractionResolver, useInteractionResolutionMutations } from "../AttentionInteractionResolver";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

const DEFAULT_VOICE = "__default__";

export interface FocusQuestionCardProps {
  item: AttentionItem;
  companyId: string;
  agentMap: Map<string, Agent>;
  currentUserId: string | null;
  prefs: FocusPrefs;
  onPrefsChange: (next: FocusPrefs) => void;
  /** Answered here: the queue marks it and opens the next question. */
  onAnswered: (itemId: string) => void;
  /** Found already closed (answered elsewhere, expired): drop without answering. */
  onGone: (itemId: string) => void;
  onSkip: () => void;
  onStep: (direction: 1 | -1) => void;
}

/**
 * One open agent question, big and alone (Decisions Focus mode, GRE-55).
 * Single-question sets get the Focus form; confirmations, suggested tasks and
 * multi-question sets render the list's own interaction card, whose buttons
 * answer and then advance the queue.
 */
export function FocusQuestionCard(props: FocusQuestionCardProps) {
  const { item } = props;
  const issueId = focusItemIssueId(item)!;
  const { data: interactions, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.interactions(issueId),
    queryFn: () => issuesApi.listInteractions(issueId),
    enabled: !!issueId,
  });
  const interaction = useMemo<IssueThreadInteraction | null>(() => {
    const match = (interactions ?? []).find((entry) => entry.id === item.subject.id);
    return match && isIssueThreadInteraction(match) ? match : null;
  }, [interactions, item.subject.id]);

  // Double-submit guard: once we are answering this card, a status flip to
  // "answered" is ours, not someone else's.
  const answeringRef = useRef(false);
  const { onGone } = props;
  useEffect(() => {
    if (isLoading || answeringRef.current) return;
    if (error || !interaction || interaction.status !== "pending") onGone(item.id);
  }, [error, interaction, isLoading, item.id, onGone]);

  if (isLoading || !interaction || interaction.status !== "pending") {
    return (
      <FocusCardShell>
        <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading question…
        </div>
      </FocusCardShell>
    );
  }

  return <FocusQuestionBody {...props} issueId={issueId} interaction={interaction} answeringRef={answeringRef} />;
}

function FocusCardShell({ children }: { children: ReactNode }) {
  return (
    <article className="mx-auto w-full max-w-3xl space-y-5 rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm">
      {children}
    </article>
  );
}

function FocusQuestionBody({
  item,
  companyId,
  agentMap,
  currentUserId,
  prefs,
  onPrefsChange,
  onAnswered,
  onSkip,
  onStep,
  issueId,
  interaction,
  answeringRef,
}: FocusQuestionCardProps & {
  issueId: string;
  interaction: IssueThreadInteraction;
  answeringRef: { current: boolean };
}) {
  const agent = interaction.createdByAgentId ? agentMap.get(interaction.createdByAgentId) ?? null : null;
  const agentName = agent?.name ?? item.originAgentName ?? null;
  const task = item.relatedIssue;
  const nativeQuestion = focusNativeQuestion(interaction);
  const content = useMemo(() => focusSpeechContent(interaction, item.subject.title), [interaction, item.subject.title]);
  const parts = useMemo<SpokenPart[]>(
    () =>
      buildSpokenSummary({
        agentName,
        taskIdentifier: task?.identifier ?? null,
        taskTitle: task?.title ?? null,
        ...content,
      }),
    [agentName, content, task?.identifier, task?.title],
  );
  const partTexts = useMemo(() => parts.map((part) => part.text), [parts]);
  const reader = useSpeechReader({ parts: partTexts, rate: prefs.rate, voiceURI: prefs.voiceURI });
  const spoken = reader.currentIndex != null ? parts[reader.currentIndex] ?? null : null;

  // "Read each question aloud": start as soon as the question opens.
  const autoReadRef = useRef(prefs.autoRead);
  autoReadRef.current = prefs.autoRead;
  const { play } = reader;
  useEffect(() => {
    if (autoReadRef.current) play();
  }, [interaction.id, play]);

  const answered = useCallback(() => {
    answeringRef.current = true;
    onAnswered(item.id);
  }, [answeringRef, item.id, onAnswered]);

  const background = content.background ? plainTextFromMarkdown(content.background) : "";
  const backgroundSentences = splitSentences(background);

  return (
    <FocusCardShell>
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <AgentAvatar agent={agent} name={agentName ?? "Agent"} size={32} />
        <span className="font-semibold">{agentName ?? "An agent"}</span>
        <span className="text-muted-foreground">asks on</span>
        {task && (
          <Link
            to={task.href ?? "#"}
            className="max-w-full truncate rounded-full border border-border px-2.5 py-0.5 text-xs font-medium hover:bg-accent"
          >
            {[task.identifier, task.title].filter(Boolean).join(" · ")}
          </Link>
        )}
        <span className="text-xs text-muted-foreground">· {relativeTime(interaction.createdAt)}</span>
      </header>

      <h2
        className={cn(
          "text-xl font-bold leading-snug break-words",
          spoken?.kind === "question" && "rounded-sm bg-primary/15",
        )}
      >
        {content.question}
      </h2>

      {reader.supported && (
        <ListenBar
          playing={reader.playing}
          currentIndex={reader.currentIndex}
          total={parts.length}
          onToggle={reader.toggle}
          prefs={prefs}
          onPrefsChange={onPrefsChange}
          voices={reader.voices}
        />
      )}

      {nativeQuestion && backgroundSentences.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Summary</h3>
          <p className="text-sm leading-relaxed">
            {backgroundSentences.map((sentence, index) => (
              <span
                key={index}
                className={cn(
                  spoken?.kind === "background" && spoken.sentenceIndex === index && "rounded-sm bg-primary/15",
                )}
              >
                {sentence}{" "}
              </span>
            ))}
          </p>
        </section>
      )}

      {nativeQuestion ? (
        <FocusAnswerForm
          key={interaction.id}
          companyId={companyId}
          issueId={issueId}
          interactionId={interaction.id}
          question={nativeQuestion}
          spokenOptionIndex={spoken?.kind === "option" ? spoken.optionIndex : null}
          reader={reader}
          taskHref={item.subject.href ?? task?.href ?? null}
          onAnswered={answered}
          answeringRef={answeringRef}
          onSkip={onSkip}
          onStep={onStep}
        />
      ) : (
        <>
          <AttentionInteractionResolver
            companyId={companyId}
            issueId={issueId}
            interactionId={interaction.id}
            agentMap={agentMap}
            currentUserId={currentUserId}
            onResolved={answered}
          />
          <FocusFooter
            taskHref={item.subject.href ?? task?.href ?? null}
            onSkip={onSkip}
            hint="Answer on the card above. The next question opens when you do."
          />
          <FocusKeyHints native={false} />
          <FocusKeys onStep={onStep} onTogglePlay={reader.toggle} />
        </>
      )}
    </FocusCardShell>
  );
}

function ListenBar({
  playing,
  currentIndex,
  total,
  onToggle,
  prefs,
  onPrefsChange,
  voices,
}: {
  playing: boolean;
  currentIndex: number | null;
  total: number;
  onToggle: () => void;
  prefs: FocusPrefs;
  onPrefsChange: (next: FocusPrefs) => void;
  voices: SpeechSynthesisVoice[];
}) {
  const language = (typeof navigator !== "undefined" ? navigator.language : "en").slice(0, 2);
  const localVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith(language.toLowerCase()));
  const status = playing ? "Playing summary" : currentIndex != null ? "Paused" : "Listen to this question";
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-accent px-3 py-2.5 text-accent-foreground">
      <Button
        size="icon"
        className="shrink-0 rounded-full"
        onClick={onToggle}
        aria-label={playing ? "Pause summary" : "Play summary"}
        aria-pressed={playing}
      >
        {playing ? <Pause /> : <Play />}
      </Button>
      <AudioLines aria-hidden className={cn("size-6 shrink-0 text-primary", playing && "animate-pulse")} />
      <div className="min-w-0 flex-1" aria-live="polite">
        <p className="text-sm font-semibold">
          {status}
          {currentIndex != null && (
            <span className="font-normal text-muted-foreground"> · part {currentIndex + 1} of {total}</span>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          Reads: who asks, the task, the question, the short background, and the options.
        </p>
      </div>
      {localVoices.length > 1 && (
        <Select
          value={prefs.voiceURI ?? DEFAULT_VOICE}
          onValueChange={(value) => onPrefsChange({ ...prefs, voiceURI: value === DEFAULT_VOICE ? null : value })}
        >
          <SelectTrigger size="sm" className="max-w-40 bg-background" aria-label="Reading voice">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_VOICE}>Default voice</SelectItem>
            {localVoices.map((voice) => (
              <SelectItem key={voice.voiceURI} value={voice.voiceURI}>
                {voice.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button
        variant="outline"
        size="sm"
        className="bg-background tabular-nums"
        onClick={() => onPrefsChange({ ...prefs, rate: nextFocusSpeed(prefs.rate) })}
        aria-label={`Reading speed ${prefs.rate}×. Speeds: ${FOCUS_SPEEDS.join(", ")}.`}
      >
        {prefs.rate}×
      </Button>
    </div>
  );
}

function FocusAnswerForm({
  companyId,
  issueId,
  interactionId,
  question,
  spokenOptionIndex,
  reader,
  taskHref,
  onAnswered,
  answeringRef,
  onSkip,
  onStep,
}: {
  companyId: string;
  issueId: string;
  interactionId: string;
  question: AskUserQuestionsQuestion;
  spokenOptionIndex: number | null;
  reader: ReturnType<typeof useSpeechReader>;
  taskHref: string | null;
  onAnswered: () => void;
  answeringRef: { current: boolean };
  onSkip: () => void;
  onStep: (direction: 1 | -1) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { respondMutation } = useInteractionResolutionMutations({ companyId, issueId, onResolved: onAnswered });

  const options = question.options;
  const pickOption = useCallback(
    (index: number, fromVoice = false) => {
      const option = options[index];
      if (!option) return;
      setSelected((current) => {
        if (question.selectionMode !== "multi") return [option.id];
        if (current.includes(option.id)) return fromVoice ? current : current.filter((id) => id !== option.id);
        return [...current, option.id];
      });
    },
    [options, question.selectionMode],
  );

  const dictation = useDictation({
    onFinal: (text) => {
      if (!text) return;
      setNote((current) => (current.trim() ? `${current.trimEnd()} ${text}` : text));
      const optionNumber = parseOptionCommand(text, options.length);
      if (optionNumber) pickOption(optionNumber - 1, true);
    },
  });

  const freeTextPicked = options.some((option) => option.freeText && selected.includes(option.id));
  const noteIsSent = question.allowOther !== false || freeTextPicked;
  const trimmedNote = note.trim();
  const canSubmit =
    !respondMutation.isPending && (selected.length > 0 || (noteIsSent && trimmedNote.length > 0));

  const submit = useCallback(() => {
    if (!canSubmit || answeringRef.current) return;
    answeringRef.current = true;
    dictation.stop();
    reader.stop();
    setSubmitError(null);
    respondMutation
      .mutateAsync({
        interactionId,
        answers: [
          {
            questionId: question.id,
            optionIds: selected,
            ...(noteIsSent && trimmedNote ? { otherText: trimmedNote } : {}),
          },
        ],
      })
      .catch((error: unknown) => {
        answeringRef.current = false;
        setSubmitError(error instanceof Error ? error.message : "Could not save the answer.");
      });
  }, [answeringRef, canSubmit, dictation, interactionId, noteIsSent, question.id, reader, respondMutation, selected, trimmedNote]);

  const toggleMic = useCallback(() => {
    // The mic must not hear the reader.
    if (!dictation.listening) reader.pause();
    dictation.toggle();
  }, [dictation, reader]);

  return (
    <>
      {options.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Options</h3>
          <div
            className="space-y-2"
            role={question.selectionMode === "multi" ? "group" : "radiogroup"}
            aria-label="Options"
          >
            {options.map((option, index) => {
              const isSelected = selected.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  role={question.selectionMode === "multi" ? "checkbox" : "radio"}
                  aria-checked={isSelected}
                  onClick={() => pickOption(index)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    isSelected ? "border-primary bg-accent ring-1 ring-primary" : "border-border hover:bg-accent/60",
                    spokenOptionIndex === index && !isSelected && "bg-primary/10",
                  )}
                >
                  <kbd className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm border border-border bg-background font-mono text-xs text-muted-foreground">
                    {index + 1}
                  </kbd>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{option.label}</span>
                    {option.description && (
                      <span className="block text-sm text-muted-foreground">{option.description}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {options.length > 0 ? "Your note (optional)" : "Your answer"}
        </h3>
        <div
          className={cn(
            "flex items-start gap-3 rounded-lg border bg-background p-3 transition-colors",
            dictation.listening ? "border-destructive" : "border-input focus-within:border-ring",
          )}
        >
          {dictation.available && (
            <button
              type="button"
              onClick={toggleMic}
              aria-label={dictation.listening ? "Stop speaking" : "Speak your answer"}
              aria-pressed={dictation.listening}
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                dictation.listening
                  ? "bg-destructive text-white ring-4 ring-destructive/20"
                  : "bg-accent text-primary hover:bg-accent/70",
              )}
            >
              <Mic className="size-4" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            {dictation.listening && (
              <p className="text-xs font-semibold uppercase tracking-wide text-destructive">Listening… tap to stop</p>
            )}
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={dictation.available ? "Type, or press the mic and speak. Say “option two” to pick option 2." : "Type a note"}
              aria-label={options.length > 0 ? "Your note" : "Your answer"}
              className="min-h-16 resize-y border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            {dictation.interim && <p className="text-sm text-muted-foreground">{dictation.interim}</p>}
          </div>
        </div>
        {!noteIsSent && trimmedNote && (
          <p className="text-xs text-muted-foreground">This question takes options only, so the note is not sent.</p>
        )}
      </section>

      {submitError && <p className="text-sm text-destructive">{submitError}</p>}

      <FocusFooter
        taskHref={taskHref}
        onSkip={onSkip}
        submit={
          <Button onClick={submit} disabled={!canSubmit}>
            {respondMutation.isPending ? <Loader2 className="animate-spin" /> : null}
            Submit &amp; next
            <ArrowRight />
          </Button>
        }
      />
      <FocusKeyHints native micAvailable={dictation.available} />
      <FocusKeys
        onStep={onStep}
        onTogglePlay={reader.toggle}
        onToggleMic={dictation.available ? toggleMic : undefined}
        onPick={(index) => pickOption(index)}
        onSubmit={submit}
      />
    </>
  );
}

function FocusFooter({
  taskHref,
  onSkip,
  submit,
  hint,
}: {
  taskHref: string | null;
  onSkip: () => void;
  submit?: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" onClick={onSkip}>
        Skip for now
      </Button>
      {taskHref && (
        <Button variant="outline" asChild>
          <Link to={taskHref}>
            Open task
            <ArrowUpRight />
          </Link>
        </Button>
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {submit && <div className="ml-auto">{submit}</div>}
    </div>
  );
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
      {children}
    </kbd>
  );
}

function FocusKeyHints({ native, micAvailable = false }: { native: boolean; micAvailable?: boolean }) {
  return (
    <p className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      {native && (
        <>
          <Key>1–9</Key> pick ·
        </>
      )}
      <Key>Space</Key> play / pause ·
      {native && micAvailable && (
        <>
          <Key>M</Key> speak ·
        </>
      )}
      {native && (
        <>
          <Key>⌘↵</Key> submit ·
        </>
      )}
      <Key>J</Key> / <Key>K</Key> next / previous
    </p>
  );
}

/** Focus mode keys. Letters and digits stay out of text boxes; ⌘↵ works anywhere. */
function FocusKeys({
  onStep,
  onTogglePlay,
  onToggleMic,
  onPick,
  onSubmit,
}: {
  onStep: (direction: 1 | -1) => void;
  onTogglePlay: () => void;
  onToggleMic?: () => void;
  onPick?: (index: number) => void;
  onSubmit?: () => void;
}) {
  const handlersRef = useRef({ onStep, onTogglePlay, onToggleMic, onPick, onSubmit });
  handlersRef.current = { onStep, onTogglePlay, onToggleMic, onPick, onSubmit };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || hasBlockingShortcutDialog(document)) return;
      const handlers = handlersRef.current;
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        if (!handlers.onSubmit) return;
        event.preventDefault();
        handlers.onSubmit();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isKeyboardShortcutTextInputTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === " ") {
        // Let Space press a focused button or link as usual.
        if (event.target instanceof HTMLElement && event.target.closest("button, a, [role='button']")) return;
        event.preventDefault();
        handlers.onTogglePlay();
      } else if (key === "m" && handlers.onToggleMic) {
        event.preventDefault();
        handlers.onToggleMic();
      } else if (key === "j" || key === "k") {
        event.preventDefault();
        handlers.onStep(key === "j" ? 1 : -1);
      } else if (/^[1-9]$/.test(key) && handlers.onPick) {
        event.preventDefault();
        handlers.onPick(Number(key) - 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return null;
}

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, FileText, Loader2, MessageCircle, Mic, MicOff, Paperclip, Send, Sparkles, X } from "lucide-react";
import type { Agent, IssueComment } from "@greatstone/shared";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import { useCompany } from "../context/CompanyContext";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { decisionsFeedApi } from "../api/decisionsFeed";
import { teamScorecardApi } from "../api/teamScorecard";
import { agentWorkDigestApi } from "../api/agentWorkDigest";
import { agentChatsApi } from "../api/agentChats";
import { queryKeys } from "../lib/queryKeys";
import { useAgentChatEnabled } from "../hooks/useAgentChatEnabled";
import { useDictation } from "../hooks/useDictation";
import { useFileIntake } from "../hooks/useFileIntake";
import {
  SUGGESTED_QUESTIONS,
  answerAgent,
  answerAway,
  answerDecide,
  answerOverview,
  answerStuck,
  answerSubject,
  classifyQuestion,
  type AskAnswer,
  type AskIntent,
} from "../lib/ask-everest";
import { OPEN_ASK_EVEREST_EVENT } from "../lib/ask-everest-events";
import { leadChatHref, resolveLeadAgent } from "./MobileEverestButton";
import { AgentAvatar } from "./AgentAvatar";
import { MarkdownBody } from "./MarkdownBody";

/** How long the panel waits for the lead agent's own reply before pointing at the chat. */
const LIVE_REPLY_WAIT_MS = 5 * 60 * 1000;

/**
 * Ask Everest from any screen (Ctrl/Cmd+J, the top bar or the command
 * palette). The answer comes straight from GSAM's data; "Ask Everest to look
 * into it" posts the question in the lead agent's chat and shows the reply
 * here when it lands.
 */
export function AskEverestPanel() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [question, setQuestion] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [questionFiles, setQuestionFiles] = useState<File[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "j" && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }
    function handleOpen(event: Event) {
      const preset = (event as CustomEvent<{ question?: string }>).detail?.question?.trim() ?? "";
      setOpen(true);
      if (preset) {
        setDraft("");
        setQuestion(preset);
        setQuestionFiles([]);
      }
    }
    document.addEventListener("keydown", handleKey);
    window.addEventListener(OPEN_ASK_EVEREST_EVENT, handleOpen);
    return () => {
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener(OPEN_ASK_EVEREST_EVENT, handleOpen);
    };
  }, []);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-hidden p-0 sm:max-w-lg"
        data-testid="ask-everest-panel"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        {open ? (
          <AskEverestBody
            draft={draft}
            setDraft={setDraft}
            question={question}
            files={files}
            setFiles={setFiles}
            questionFiles={questionFiles}
            onAsk={(text) => {
              setQuestion(text);
              setQuestionFiles(files);
              setFiles([]);
              setDraft("");
            }}
            onReset={() => {
              setQuestion(null);
              setQuestionFiles([]);
            }}
            onNavigate={() => setOpen(false)}
            inputRef={inputRef}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function AskEverestBody({
  draft,
  setDraft,
  files,
  setFiles,
  questionFiles,
  question,
  onAsk,
  onReset,
  onNavigate,
  inputRef,
}: {
  draft: string;
  setDraft: (value: string) => void;
  /** Files waiting to go with the next question. */
  files: File[];
  setFiles: (files: File[]) => void;
  /** Files sent with the current question. */
  questionFiles: File[];
  question: string | null;
  onAsk: (question: string) => void;
  onReset: () => void;
  onNavigate: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const { selectedCompanyId } = useCompany();
  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const lead = useMemo(() => resolveLeadAgent(agents), [agents]);
  const leadName = lead?.name ?? "Everest";
  const exampleAgent = agents.find((agent) => agent.id !== lead?.id && agent.status !== "terminated");
  const suggestions = [
    ...SUGGESTED_QUESTIONS,
    ...(exampleAgent ? [`What did ${exampleAgent.name} do today?`] : []),
  ];

  // Speak the question where the browser supports it (Chrome, Safari, Edge).
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dictation = useDictation({
    onFinal: (text) => {
      const heard = text.trim();
      if (!heard) return;
      setDraft(draftRef.current.trim() ? `${draftRef.current.trim()} ${heard}` : heard);
    },
  });

  // Files come in by the paperclip, a drop on the box, or a paste (a screenshot).
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addFiles = (incoming: File[]) => setFiles([...files, ...incoming].slice(0, MAX_ASK_FILES));
  const intake = useFileIntake(addFiles);
  const { tabIndex: _focusable, ...dropProps } = intake.targetProps;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (dictation.listening) dictation.stop();
    const text = draft.trim() || (files.length > 0 ? filesOnlyQuestion(files.length) : "");
    if (text) onAsk(text);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        {lead ? <AgentAvatar agent={lead} size={40} /> : <Sparkles className="mt-1 h-6 w-6 text-primary" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          <SheetTitle className="text-base font-semibold">Ask {leadName}</SheetTitle>
          <SheetDescription className="text-(length:--text-compact) text-muted-foreground">
            Ask anything in plain English. You get an answer from what GSAM knows straight away, and {leadName} can dig deeper.
          </SheetDescription>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {question && selectedCompanyId ? (
          <AskConversation
            key={question}
            companyId={selectedCompanyId}
            question={question}
            files={questionFiles}
            agents={agents}
            lead={lead}
            onNavigate={onNavigate}
          />
        ) : (
          <div className="space-y-3" data-testid="ask-everest-suggestions">
            <p className="text-sm text-muted-foreground">Try one of these:</p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => onAsk(suggestion)}
                  className="rounded-full border border-border bg-background px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <form
        onSubmit={submit}
        {...dropProps}
        data-testid="ask-everest-form"
        data-dragging={intake.dragging || undefined}
        className={cn("space-y-2 border-t border-border px-4 py-3 transition-colors", intake.dragging && "bg-accent")}
      >
        {files.length > 0 ? (
          <ul className="flex flex-wrap gap-2" data-testid="ask-everest-files" aria-label="Files to send">
            {files.map((file, index) => (
              <FileChip key={`${file.name}-${index}`} file={file} onRemove={() => setFiles(files.filter((_, at) => at !== index))} />
            ))}
          </ul>
        ) : intake.dragging ? (
          <p className="text-xs text-muted-foreground">Drop to send with your question</p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={files.length >= MAX_ASK_FILES}
            aria-label="Add a file"
            title="Add a file. You can also drop one here or paste a screenshot."
            data-testid="ask-everest-attach"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={dictation.listening
              ? (dictation.interim || "Listening…")
              : question ? "Ask something else" : "What is stuck on the Indago work?"}
            aria-label={`Ask ${leadName} a question`}
            className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-(length:--rad-3) focus-visible:ring-ring"
          />
          {dictation.available ? (
            <Button
              type="button"
              variant={dictation.listening ? "default" : "ghost"}
              size="sm"
              onClick={dictation.toggle}
              aria-pressed={dictation.listening}
              aria-label={dictation.listening ? "Stop listening" : "Speak your question"}
              title={dictation.listening ? "Stop listening" : "Speak your question"}
              data-testid="ask-everest-mic"
            >
              {dictation.listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </Button>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            data-testid="ask-everest-file-input"
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <Button type="submit" size="sm" disabled={!draft.trim() && files.length === 0} aria-label="Ask">
            <Send className="h-4 w-4" />
          </Button>
          {question ? (
            <Button type="button" variant="ghost" size="sm" onClick={onReset}>
              Clear
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

type PanelAgent = Agent;

/** At most this many files go with one question. */
export const MAX_ASK_FILES = 5;

/** What is asked when someone sends files with no words. */
export function filesOnlyQuestion(count: number) {
  return count === 1 ? "Please take a look at this file." : "Please take a look at these files.";
}

/** One waiting file: a small preview for an image, a name and a remove button. */
function FileChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  const isImage = file.type.startsWith("image/");
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);
  return (
    <li className="flex max-w-full items-center gap-2 rounded-lg border border-border bg-muted/40 py-1 pl-1 pr-2 text-xs">
      {preview ? (
        <img src={preview} alt="" className="h-8 w-8 rounded object-cover" />
      ) : (
        <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="min-w-0 max-w-(--sz-160px) truncate">{file.name}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function AskConversation({
  companyId,
  question,
  files,
  agents,
  lead,
  onNavigate,
}: {
  companyId: string;
  question: string;
  files: File[];
  agents: readonly PanelAgent[];
  lead: PanelAgent | null;
  onNavigate: () => void;
}) {
  const intent = useMemo<AskIntent>(() => classifyQuestion(question, agents), [question, agents]);
  const answer = useInstantAnswer(companyId, intent, agents);
  return (
    <div className="space-y-4">
      <div className="ml-auto w-fit max-w-full rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
        {question}
        {files.length > 0 ? (
          <span className="mt-1 block text-xs opacity-80" data-testid="ask-everest-question-files">
            {files.map((file) => file.name).join(", ")}
          </span>
        ) : null}
      </div>
      <section aria-live="polite" className="space-y-3" data-testid="ask-everest-answer">
        {answer.loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Looking through GSAM…
          </p>
        ) : answer.error ? (
          <p className="text-sm text-destructive">I could not read that from GSAM: {answer.error}</p>
        ) : answer.value ? (
          <AnswerCard answer={answer.value} onNavigate={onNavigate} />
        ) : null}
      </section>
      {lead ? <LiveAsk companyId={companyId} question={question} files={files} lead={lead} onNavigate={onNavigate} /> : null}
    </div>
  );
}

function AnswerCard({ answer, onNavigate }: { answer: AskAnswer; onNavigate: () => void }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-sm font-medium leading-6 text-foreground">{answer.headline}</p>
      {answer.lines.length > 0 ? (
        <ul className="mt-3 divide-y divide-border">
          {answer.lines.map((line, index) => (
            <li key={`${line.href ?? ""}-${index}`} className="py-2">
              {line.href ? (
                <Link to={line.href} onClick={onNavigate} className="group block rounded-md outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring">
                  <span className="block text-sm text-foreground group-hover:underline">{line.text}</span>
                  {line.detail ? <span className="block text-xs text-muted-foreground">{line.detail}</span> : null}
                </Link>
              ) : (
                <>
                  <span className="block text-sm text-foreground">{line.text}</span>
                  {line.detail ? <span className="block text-xs text-muted-foreground">{line.detail}</span> : null}
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {answer.more ? (
        <Link
          to={answer.more.href}
          onClick={onNavigate}
          className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          {answer.more.label}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}

function useInstantAnswer(companyId: string, intent: AskIntent, agents: readonly PanelAgent[]) {
  const needsNeedsMe = intent.kind === "decide" || intent.kind === "overview" || intent.kind === "away";
  const digest = useQuery({
    queryKey: queryKeys.agentWorkDigest(companyId),
    queryFn: () => agentWorkDigestApi.get(companyId),
    enabled: intent.kind === "away",
  });
  const needsScorecard = intent.kind === "agent" || intent.kind === "overview";
  const needsMe = useQuery({
    queryKey: queryKeys.decisionsFeed.needsMe(companyId),
    queryFn: () => decisionsFeedApi.needsMe(companyId),
    enabled: needsNeedsMe,
  });
  const scorecard = useQuery({
    queryKey: queryKeys.teamScorecard(companyId, 7),
    queryFn: () => teamScorecardApi.get(companyId, 7),
    enabled: needsScorecard,
    retry: false,
  });
  const issues = useQuery({
    queryKey: ["ask-everest", companyId, "issues", intent],
    queryFn: () => {
      if (intent.kind === "away") return issuesApi.list(companyId, { status: "blocked", sortField: "updated", limit: 50 });
      if (intent.kind === "stuck") {
        return issuesApi.list(companyId, { status: "blocked", q: intent.subject ?? undefined, includeBlockedBy: true, limit: 50 });
      }
      if (intent.kind === "agent") {
        return issuesApi.list(companyId, { assigneeAgentId: intent.agentId, sortField: "updated", limit: 40 });
      }
      if (intent.kind === "subject") return issuesApi.list(companyId, { q: intent.subject, limit: 50 });
      return Promise.resolve([]);
    },
    enabled: intent.kind === "stuck" || intent.kind === "agent" || intent.kind === "subject" || intent.kind === "away",
  });

  const agentName = (id: string | null) => (id ? agents.find((agent) => agent.id === id)?.name ?? null : null);
  const pending = (needsNeedsMe && needsMe.isPending)
    || (intent.kind === "agent" && scorecard.isPending && !scorecard.isError)
    || ((intent.kind === "stuck" || intent.kind === "agent" || intent.kind === "subject" || intent.kind === "away") && issues.isPending)
    || (intent.kind === "away" && digest.isPending);
  const error = (needsNeedsMe && intent.kind === "decide" && needsMe.error) || (intent.kind === "away" && digest.error) || issues.error;
  if (pending) return { loading: true as const };
  if (error) return { error: error instanceof Error ? error.message : "Unknown error" };

  switch (intent.kind) {
    case "away":
      return { value: answerAway(digest.data!, issues.data ?? [], needsMe.data ?? null) };
    case "decide":
      return { value: answerDecide(needsMe.data!) };
    case "stuck":
      return { value: answerStuck(issues.data ?? [], intent.subject, agentName) };
    case "agent":
      return {
        value: answerAgent(
          { id: intent.agentId, name: intent.agentName },
          intent.window,
          scorecard.data ?? null,
          issues.data ?? [],
        ),
      };
    case "subject":
      return { value: answerSubject(intent.subject, issues.data ?? []) };
    default:
      return { value: answerOverview(scorecard.data ?? null, needsMe.data ?? null) };
  }
}

/** Find the lead's first reply after our question, newest comments first. */
export function findLeadReply(
  comments: readonly IssueComment[],
  leadId: string,
  askedAt: string,
): IssueComment | null {
  const asked = new Date(askedAt).getTime();
  const replies = comments
    .filter((comment) => (comment.authorAgentId ?? comment.derivedAuthorAgentId) === leadId)
    .filter((comment) => new Date(comment.createdAt).getTime() > asked)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return replies[0] ?? null;
}

function LiveAsk({
  companyId,
  question,
  files,
  lead,
  onNavigate,
}: {
  companyId: string;
  question: string;
  files: File[];
  lead: PanelAgent;
  onNavigate: () => void;
}) {
  const { enabled: chatEnabled, loaded } = useAgentChatEnabled();
  const send = useMutation({
    mutationFn: async () => {
      const chat = await agentChatsApi.ensure(companyId, lead.id);
      // Files go up to the chat first, then ride on the question so the agent sees them with it.
      const attachments = [];
      for (const file of files) attachments.push(await issuesApi.uploadAttachment(companyId, chat.id, file));
      const attachmentIds = attachments.map((attachment) => attachment.id);
      const comment = await issuesApi.addComment(chat.id, question, true, undefined, attachmentIds.length ? attachmentIds : undefined, crypto.randomUUID());
      return { chatId: chat.id, askedAt: comment.createdAt ? String(comment.createdAt) : new Date().toISOString() };
    },
  });
  const sent = send.data ?? null;
  const [startedAt] = useState(() => Date.now());
  const reply = useQuery({
    queryKey: ["ask-everest", "live-reply", sent?.chatId, sent?.askedAt],
    queryFn: async () => {
      const comments = await issuesApi.listComments(sent!.chatId, { order: "desc", limit: 20 });
      return findLeadReply(comments, lead.id, sent!.askedAt);
    },
    enabled: !!sent,
    refetchInterval: (query) => (query.state.data || Date.now() - startedAt > LIVE_REPLY_WAIT_MS ? false : 4000),
  });
  const chatHref = leadChatHref(lead);

  if (!loaded || !chatEnabled) return null;

  if (!sent) {
    return (
      <div className="rounded-xl border border-dashed border-border p-4">
        <p className="text-sm text-muted-foreground">
          {files.length > 0
            ? `${lead.name} needs to read your ${files.length === 1 ? "file" : `${files.length} files`} to answer. They reply in a minute or two.`
            : `Want ${lead.name} to check properly? They read the tasks, chats and memory and reply in a minute or two.`}
        </p>
        <Button
          type="button"
          size="sm"
          className="mt-3"
          onClick={() => send.mutate()}
          disabled={send.isPending}
          data-testid="ask-everest-live"
        >
          {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <MessageCircle className="h-4 w-4" aria-hidden="true" />}
          {files.length > 0 ? `Send to ${lead.name} with ${files.length === 1 ? "the file" : `the ${files.length} files`}` : `Ask ${lead.name} to look into it`}
        </Button>
        {send.error ? (
          <p className="mt-2 text-sm text-destructive">
            Could not send it. {send.error instanceof Error ? send.error.message : "Please try again."}
          </p>
        ) : null}
      </div>
    );
  }

  const answer = reply.data;
  const gaveUp = !answer && Date.now() - startedAt > LIVE_REPLY_WAIT_MS;
  return (
    <div className="rounded-xl border border-border bg-card p-4" aria-live="polite" data-testid="ask-everest-live-reply">
      <div className="mb-2 flex items-center gap-2">
        <AgentAvatar agent={lead} size={24} />
        <span className="text-sm font-semibold">{lead.name}</span>
      </div>
      {answer ? (
        <MarkdownBody className="text-sm">{answer.body}</MarkdownBody>
      ) : gaveUp ? (
        <p className="text-sm text-muted-foreground">{lead.name} is still working on it. The answer will land in your chat.</p>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {lead.name} is looking into it…
        </p>
      )}
      <Link to={chatHref} onClick={onNavigate} className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
        Continue in the chat
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}

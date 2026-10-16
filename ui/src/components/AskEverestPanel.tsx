import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Loader2, MessageCircle, Send, Sparkles } from "lucide-react";
import type { Agent, IssueComment } from "@greatstone/shared";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { decisionsFeedApi } from "../api/decisionsFeed";
import { teamScorecardApi } from "../api/teamScorecard";
import { agentChatsApi } from "../api/agentChats";
import { queryKeys } from "../lib/queryKeys";
import { useAgentChatEnabled } from "../hooks/useAgentChatEnabled";
import {
  SUGGESTED_QUESTIONS,
  answerAgent,
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
            onAsk={(text) => {
              setQuestion(text);
              setDraft("");
            }}
            onReset={() => setQuestion(null)}
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
  question,
  onAsk,
  onReset,
  onNavigate,
  inputRef,
}: {
  draft: string;
  setDraft: (value: string) => void;
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

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
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

      <form onSubmit={submit} className="flex items-center gap-2 border-t border-border px-4 py-3">
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={question ? "Ask something else" : "What is stuck on the Indago work?"}
          aria-label={`Ask ${leadName} a question`}
          className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-(length:--rad-3) focus-visible:ring-ring"
        />
        <Button type="submit" size="sm" disabled={!draft.trim()} aria-label="Ask">
          <Send className="h-4 w-4" />
        </Button>
        {question ? (
          <Button type="button" variant="ghost" size="sm" onClick={onReset}>
            Clear
          </Button>
        ) : null}
      </form>
    </div>
  );
}

type PanelAgent = Agent;

function AskConversation({
  companyId,
  question,
  agents,
  lead,
  onNavigate,
}: {
  companyId: string;
  question: string;
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
      {lead ? <LiveAsk companyId={companyId} question={question} lead={lead} onNavigate={onNavigate} /> : null}
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
  const needsNeedsMe = intent.kind === "decide" || intent.kind === "overview";
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
      if (intent.kind === "stuck") {
        return issuesApi.list(companyId, { status: "blocked", q: intent.subject ?? undefined, includeBlockedBy: true, limit: 50 });
      }
      if (intent.kind === "agent") {
        return issuesApi.list(companyId, { assigneeAgentId: intent.agentId, sortField: "updated", limit: 40 });
      }
      if (intent.kind === "subject") return issuesApi.list(companyId, { q: intent.subject, limit: 50 });
      return Promise.resolve([]);
    },
    enabled: intent.kind === "stuck" || intent.kind === "agent" || intent.kind === "subject",
  });

  const agentName = (id: string | null) => (id ? agents.find((agent) => agent.id === id)?.name ?? null : null);
  const pending = (needsNeedsMe && needsMe.isPending)
    || (intent.kind === "agent" && scorecard.isPending && !scorecard.isError)
    || ((intent.kind === "stuck" || intent.kind === "agent" || intent.kind === "subject") && issues.isPending);
  const error = (needsNeedsMe && intent.kind === "decide" && needsMe.error) || issues.error;
  if (pending) return { loading: true as const };
  if (error) return { error: error instanceof Error ? error.message : "Unknown error" };

  switch (intent.kind) {
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
  lead,
  onNavigate,
}: {
  companyId: string;
  question: string;
  lead: PanelAgent;
  onNavigate: () => void;
}) {
  const { enabled: chatEnabled, loaded } = useAgentChatEnabled();
  const send = useMutation({
    mutationFn: async () => {
      const chat = await agentChatsApi.ensure(companyId, lead.id);
      const comment = await issuesApi.addComment(chat.id, question, true, undefined, undefined, crypto.randomUUID());
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
          Want {lead.name} to check properly? They read the tasks, chats and memory and reply in a minute or two.
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
          Ask {lead.name} to look into it
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

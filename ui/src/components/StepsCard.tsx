import { useEffect, useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RequestStepsPayload } from "@greatstone/shared";
import { Check, Clock, Copy, ExternalLink, Eye, EyeOff, KeyRound, Loader2, ShieldAlert } from "lucide-react";
import { issuesApi } from "../api/issues";
import { copyTextToClipboard } from "../lib/clipboard";
import type { IssueThreadInteraction, RequestStepsInteraction } from "../lib/issue-thread-interactions";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatShortDate } from "../lib/utils";
import { MarkdownBody } from "./MarkdownBody";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

const RISK_LABEL: Record<RequestStepsPayload["risk"], string> = {
  safe: "Safe",
  careful: "Careful",
  money_or_live: "Money or live",
};

const SECRET_HELP = "Saved straight into GSAM's encrypted secrets. Nobody, including the agent, sees it.";

function minutesLabel(minutes: number) {
  const rounded = Math.max(1, Math.round(minutes));
  return `About ${rounded} min`;
}

function plainText(markdown: string) {
  return markdown.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();
}

/** The whole card as clean text to share outside GSAM. Never includes a secret. */
export function stepsAsText(payload: RequestStepsPayload, title?: string | null) {
  const lines = [title ?? payload.title, payload.why, "", `${minutesLabel(payload.minutes)}. ${RISK_LABEL[payload.risk]}.`, ""];
  payload.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${plainText(step.text)}`);
    for (const value of step.copy ?? []) lines.push(`   Copy: ${value}`);
    if (step.link) lines.push(`   Link: ${step.link.label} (${step.link.url})`);
    if (step.expect) lines.push(`   You should see: ${step.expect}`);
  });
  if (payload.afterDone) lines.push("", `After that: ${payload.afterDone}`);
  return lines.join("\n");
}

function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-xs text-foreground hover:bg-accent"
      aria-label={copied ? `Copied ${value}` : `Copy ${value}`}
      onClick={async () => {
        await copyTextToClipboard(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      <span className="truncate">{value}</span>
      {copied ? (
        <span className="inline-flex shrink-0 items-center gap-1 font-sans text-status-success-foreground">
          <Check aria-hidden className="h-3.5 w-3.5" /> Copied
        </span>
      ) : (
        <Copy aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

function RiskChip({ risk }: { risk: RequestStepsPayload["risk"] }) {
  return (
    <span
      data-testid="steps-risk"
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
        risk === "money_or_live"
          ? "border-status-danger bg-status-danger-soft font-semibold text-status-danger-foreground"
          : risk === "careful"
            ? "border-border bg-status-warning-soft text-status-warning-foreground"
            : "border-border text-muted-foreground",
      )}
    >
      {risk === "money_or_live" ? <ShieldAlert aria-hidden className="h-3.5 w-3.5" /> : null}
      {RISK_LABEL[risk]}
    </span>
  );
}

/**
 * A step-by-step card (request_steps): an agent guides a person through steps
 * only a person can do. Ticks are saved on the card so they survive a reload.
 * The optional secret goes straight to the server on Done and is never shown
 * again. Resolves itself, so it behaves the same in task threads, chats and
 * the Decisions feed.
 */
export function StepsCard({
  interaction,
  resolvedByLabel,
  errorMessage,
}: {
  interaction: RequestStepsInteraction;
  resolvedByLabel?: string | null;
  errorMessage?: (error: unknown) => string | null;
}) {
  const { payload } = interaction;
  const queryClient = useQueryClient();
  const baseId = useId();
  const stored = payload.progress?.tickedSteps ?? [];
  const [ticked, setTicked] = useState<Set<number>>(() => new Set(stored));
  const storedKey = stored.join(",");
  useEffect(() => {
    setTicked(new Set(storedKey ? storedKey.split(",").map(Number) : []));
  }, [storedKey]);
  const [secretValue, setSecretValue] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [cantDo, setCantDo] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  const refresh = (updated?: IssueThreadInteraction) => {
    if (updated) {
      queryClient.setQueryData<IssueThreadInteraction[] | undefined>(
        queryKeys.issues.interactions(interaction.issueId),
        (current) => current?.map((item) => (item.id === updated.id ? updated : item)),
      );
    }
  };

  const saveTicks = useMutation({
    mutationFn: (tickedSteps: number[]) =>
      issuesApi.saveStepsProgress(interaction.issueId, interaction.id, tickedSteps),
    onSuccess: refresh,
  });

  const resolve = useMutation({
    mutationFn: (action: { kind: "done" } | { kind: "cant"; reason: string }) =>
      action.kind === "done"
        ? issuesApi.acceptInteraction(
            interaction.issueId,
            interaction.id,
            payload.secret ? { secretValue } : {},
          )
        : issuesApi.rejectInteraction(interaction.issueId, interaction.id, action.reason),
    onMutate: () => setError(null),
    onSuccess: (updated) => {
      setSecretValue("");
      refresh(updated);
      for (const queryKey of [
        queryKeys.issues.interactions(interaction.issueId),
        queryKeys.issues.detail(interaction.issueId),
        queryKeys.issues.comments(interaction.issueId),
        queryKeys.issues.activeRun(interaction.issueId),
        queryKeys.issues.liveRuns(interaction.issueId),
        queryKeys.attention(interaction.companyId),
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
    onError: (err) => setError(errorMessage?.(err) ?? (err instanceof Error ? err.message : "Could not send. Try again.")),
  });
  const working = resolve.isPending;

  const chips = (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5" data-testid="steps-minutes">
        <Clock aria-hidden className="h-3.5 w-3.5" />
        {minutesLabel(payload.minutes)}
      </span>
      <RiskChip risk={payload.risk} />
    </div>
  );

  if (interaction.status !== "pending") {
    const secret = interaction.result?.secret ?? null;
    const outcome =
      interaction.status === "accepted"
        ? "Done"
        : interaction.status === "rejected"
          ? "Could not do this"
          : "Closed";
    return (
      <div data-testid="steps-card" className="space-y-2">
        <p className="text-sm text-muted-foreground">{payload.why}</p>
        <p className="text-sm">
          <span className="font-medium">{outcome}</span>
          <span className="text-muted-foreground">
            {resolvedByLabel ? ` by ${resolvedByLabel}` : ""}
            {interaction.resolvedAt ? ` on ${formatShortDate(interaction.resolvedAt)}` : ""}
          </span>
        </p>
        {interaction.status === "rejected" && interaction.result?.reason ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Reason: </span>
            {interaction.result.reason}
          </p>
        ) : null}
        {secret ? (
          <p className="flex items-start gap-1.5 text-sm" data-testid="steps-secret-saved">
            <KeyRound aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span>
              Saved as <span className="font-mono">{secret.secretName}</span> in Secrets
              {secret.linkedAgentIds.length > 0
                ? `, linked to ${secret.linkedAgentIds.length} ${secret.linkedAgentIds.length === 1 ? "agent" : "agents"}`
                : ""}
              .{secret.linkingNeedsOwner ? " Linking it to agents needs an owner." : ""}
            </span>
          </p>
        ) : null}
      </div>
    );
  }

  const allTicked = payload.steps.every((_, index) => ticked.has(index));
  const access = payload.secretAccess ?? null;
  const secretBlocked = Boolean(payload.secret && access && !access.addresseeCanSave);
  const secretReady = !payload.secret || secretValue.trim().length > 0;
  const prefixMismatch = Boolean(
    payload.secret?.expectedPrefix && secretValue.trim() && !secretValue.trim().startsWith(payload.secret.expectedPrefix),
  );
  const canFinish = allTicked && secretReady && !secretBlocked && !working;
  const left = payload.steps.length - payload.steps.filter((_, index) => ticked.has(index)).length;

  const toggle = (index: number, value: boolean) => {
    const next = new Set(ticked);
    if (value) next.add(index);
    else next.delete(index);
    setTicked(next);
    saveTicks.mutate([...next].sort((a, b) => a - b));
  };

  return (
    <div data-testid="steps-card" className="space-y-3">
      <p className="text-sm text-muted-foreground">{payload.why}</p>
      {chips}

      <ol className="space-y-3">
        {payload.steps.map((step, index) => {
          const checkboxId = `${baseId}-step-${index}`;
          const done = ticked.has(index);
          return (
            <li key={index} className="flex gap-3" data-testid="steps-step">
              <Checkbox
                id={checkboxId}
                checked={done}
                disabled={working}
                onCheckedChange={(value) => toggle(index, value === true)}
                aria-label={`Step ${index + 1} done`}
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex gap-2">
                  <span aria-hidden className="font-semibold tabular-nums text-muted-foreground">
                    {index + 1}.
                  </span>
                  <MarkdownBody className={cn("min-w-0 text-sm", done && "text-muted-foreground")}>{step.text}</MarkdownBody>
                </div>
                {step.copy?.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {step.copy.map((value) => (
                      <CopyChip key={value} value={value} />
                    ))}
                  </div>
                ) : null}
                {step.link ? (
                  <a
                    href={step.link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {step.link.label}
                    <ExternalLink aria-hidden className="h-3.5 w-3.5" />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                ) : null}
                {step.expect ? (
                  <p className="text-xs text-muted-foreground">You should see: {plainText(step.expect)}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      {payload.secret ? (
        <div className="space-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2.5" data-testid="steps-secret">
          <label htmlFor={`${baseId}-secret`} className="flex items-center gap-1.5 text-sm font-medium">
            <KeyRound aria-hidden className="h-4 w-4 text-muted-foreground" />
            {payload.secret.secretName}
          </label>
          <p className="text-xs text-muted-foreground">{payload.secret.description}</p>
          {secretBlocked ? (
            <p className="text-sm" data-testid="steps-secret-who-can">
              Only someone who can manage this company's secrets can save it.
              {access?.whoCan.length ? ` Ask ${access.whoCan.join(", ")}.` : " Ask a company owner."}
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Input
                  id={`${baseId}-secret`}
                  type={showSecret ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  value={secretValue}
                  onChange={(event) => setSecretValue(event.target.value)}
                  disabled={working}
                  placeholder={payload.secret.expectedPrefix ? `Starts with ${payload.secret.expectedPrefix}` : "Paste it here"}
                  aria-describedby={`${baseId}-secret-help`}
                  className="font-mono"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowSecret((value) => !value)}
                  aria-label={showSecret ? "Hide the secret" : "Show the secret"}
                  aria-pressed={showSecret}
                >
                  {showSecret ? <EyeOff aria-hidden className="h-4 w-4" /> : <Eye aria-hidden className="h-4 w-4" />}
                </Button>
              </div>
              {prefixMismatch ? (
                <p className="text-xs text-status-warning-foreground" role="status">
                  This usually starts with {payload.secret.expectedPrefix}. Check you copied the right one; you can still save it.
                </p>
              ) : null}
              <p id={`${baseId}-secret-help`} className="text-xs text-muted-foreground">
                {SECRET_HELP}
              </p>
            </>
          )}
        </div>
      ) : null}

      {payload.afterDone ? (
        <p className="text-xs text-muted-foreground">After that: {payload.afterDone}</p>
      ) : null}

      {cantDo ? (
        <div className="space-y-2">
          <label htmlFor={`${baseId}-reason`} className="text-xs text-muted-foreground">
            What stopped you? A line is enough.
          </label>
          <Textarea
            id={`${baseId}-reason`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="For example: I don't have access to that dashboard"
            autoFocus
            disabled={working}
          />
        </div>
      ) : null}

      <div aria-live="assertive">
        {error ? (
          <p className="rounded-sm border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mr-auto"
          onClick={async () => {
            await copyTextToClipboard(stepsAsText(payload, interaction.title));
            setCopiedAll(true);
            window.setTimeout(() => setCopiedAll(false), 1500);
          }}
        >
          {copiedAll ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}
          {copiedAll ? "Copied" : "Copy steps"}
        </Button>
        {cantDo ? (
          <>
            <Button type="button" size="sm" variant="ghost" disabled={working} onClick={() => setCantDo(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={working || !reason.trim()}
              onClick={() => resolve.mutate({ kind: "cant", reason: reason.trim() })}
            >
              Send
            </Button>
          </>
        ) : (
          <>
            <Button type="button" size="sm" variant="outline" disabled={working} onClick={() => setCantDo(true)}>
              I can't do this
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canFinish}
              title={!allTicked ? `Tick ${left} more ${left === 1 ? "step" : "steps"} first` : !secretReady ? `Enter ${payload.secret?.secretName}` : undefined}
              onClick={() => resolve.mutate({ kind: "done" })}
            >
              {working ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : null}
              Done
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

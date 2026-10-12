import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, Monitor } from "lucide-react";
import type { DecisionCardAction } from "@greatstone/shared";
import { copyTextToClipboard } from "../../lib/clipboard";
import { Button } from "../ui/button";

/** The command to run, in a copy box, and Done, which wakes the agent to check. */
export function AtDeskPanel({
  command,
  doneAction,
  pending,
  onDone,
}: {
  command: string | null;
  doneAction: DecisionCardAction | null;
  pending: boolean;
  onDone: () => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3" data-at-desk-panel>
      <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Monitor className="size-3.5" aria-hidden />
        At your desk
      </p>
      {command ? <CommandCopyBox command={command} /> : null}
      {doneAction ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={pending} title={doneAction.description} onClick={onDone}>
            {pending ? <Loader2 className="animate-spin" /> : <Check />}
            {doneAction.label}
          </Button>
          <span className="text-xs text-muted-foreground">{doneAction.description}</span>
        </div>
      ) : null}
    </div>
  );
}

export function CommandCopyBox({ command }: { command: string }) {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const copy = async () => {
    try {
      await copyTextToClipboard(command);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-background p-2">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-sm" aria-label="Command">
        {command}
      </pre>
      <Button type="button" size="xs" variant="outline" className="shrink-0" onClick={() => void copy()} aria-label="Copy command">
        {copied === "copied" ? <Check /> : <Copy />}
        {copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
      </Button>
    </div>
  );
}

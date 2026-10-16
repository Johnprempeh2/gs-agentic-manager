import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyMarkdownToClipboard } from "../lib/markdown-clipboard";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

/**
 * Copies a markdown body as clean rich text plus plain text, so it pastes
 * into Outlook, Word or a plain-text field in the target app's own look
 * (GRE-1585).
 */
export function CopyMarkdownButton({
  markdown,
  label = "Copy",
  className,
}: {
  markdown: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const copy = async () => {
    try {
      await copyMarkdownToClipboard(markdown);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState("idle"), 1500);
  };

  const text = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className={cn("text-muted-foreground", state === "copied" && "text-foreground", className)}
      onClick={() => void copy()}
    >
      {state === "copied" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      <span>{text}</span>
    </Button>
  );
}

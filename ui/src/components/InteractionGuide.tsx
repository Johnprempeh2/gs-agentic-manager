import { useId, type ReactNode } from "react";
import { BookOpenText } from "lucide-react";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "./MarkdownBody";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  interactionGuideSummary,
  needsInteractionGuide,
  splitInteractionGuide,
} from "@/lib/interaction-guide";
import { cn } from "@/lib/utils";

/**
 * Help text on an interaction card (GRE-916). Short text renders inline as
 * markdown. Long or step-by-step text (code blocks, numbered steps) shows a
 * one- or two-line summary and an "Open step-by-step guide" link instead, so
 * the card stays short and the answer options stay in view.
 */
export function InteractionGuideText({
  markdown,
  onOpenGuide,
  externalReferences,
  className,
}: {
  markdown: string | null | undefined;
  onOpenGuide: () => void;
  externalReferences?: MarkdownExternalReferenceMap;
  className?: string;
}) {
  const text = markdown?.trim();
  if (!text) return null;
  if (!needsInteractionGuide(text)) {
    return (
      <MarkdownBody className={className} externalReferences={externalReferences}>
        {text}
      </MarkdownBody>
    );
  }
  return (
    <div className={cn("space-y-1.5", className)} data-testid="interaction-guide-summary">
      <p className="leading-6">{interactionGuideSummary(text)}</p>
      <InteractionGuideLink onClick={onOpenGuide} />
    </div>
  );
}

export function InteractionGuideLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      className="inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-primary underline underline-offset-4 outline-none hover:text-primary/80 focus-visible:ring-(length:--rad-3) focus-visible:ring-ring/50"
    >
      <BookOpenText aria-hidden className="h-4 w-4" />
      Open step-by-step guide
    </button>
  );
}

/**
 * The full guide for one interaction: the steps as numbered blocks with
 * copyable code, then the same answer controls the card shows. The answer
 * controls are passed in by the card, so answering here resolves the same
 * interaction through the same handlers.
 */
export function InteractionGuideSheet({
  open,
  onOpenChange,
  title,
  lead,
  markdown,
  externalReferences,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Short context shown under the title (for example the question prompt). */
  lead?: string | null;
  markdown: string;
  externalReferences?: MarkdownExternalReferenceMap;
  /** The answer controls. */
  children?: ReactNode;
}) {
  const answerHeadingId = useId();
  const { intro, steps, outro } = splitInteractionGuide(markdown);
  const numbered = steps.length > 1;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="interaction-guide w-full gap-0 p-0 sm:max-w-2xl"
        data-testid="interaction-guide"
      >
        <SheetHeader className="border-b border-border pr-12">
          <SheetTitle className="text-base">{title}</SheetTitle>
          {lead ? (
            <SheetDescription asChild>
              <div>
                <MarkdownBody className="text-sm text-muted-foreground" externalReferences={externalReferences}>
                  {lead}
                </MarkdownBody>
              </div>
            </SheetDescription>
          ) : (
            <SheetDescription>
              {numbered ? `${steps.length} steps. Answer at the end.` : "Read the guide, then answer at the end."}
            </SheetDescription>
          )}
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {intro ? (
            <MarkdownBody className="text-sm" externalReferences={externalReferences}>
              {intro}
            </MarkdownBody>
          ) : null}
          {numbered ? (
            <ol className="space-y-3" aria-label="Steps">
              {steps.map((step, index) => (
                <li
                  key={index}
                  className="flex gap-3 rounded-lg border border-border/70 bg-background/80 p-4"
                  data-testid="interaction-guide-step"
                >
                  <span
                    aria-hidden
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    {step.title && /^step\s+\d/i.test(step.title) ? null : (
                      <span className="sr-only">Step {index + 1}. </span>
                    )}
                    {step.title ? (
                      <div className="mb-1 text-sm font-semibold text-foreground">{step.title}</div>
                    ) : null}
                    {step.body ? (
                      <MarkdownBody className="text-sm" externalReferences={externalReferences}>
                        {step.body}
                      </MarkdownBody>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : steps[0] ? (
            <div className="rounded-lg border border-border/70 bg-background/80 p-4" data-testid="interaction-guide-step">
              {steps[0].title ? (
                <div className="mb-1 text-sm font-semibold text-foreground">{steps[0].title}</div>
              ) : null}
              <MarkdownBody className="text-sm" externalReferences={externalReferences}>
                {steps[0].body}
              </MarkdownBody>
            </div>
          ) : null}
          {outro ? (
            <MarkdownBody className="text-sm" externalReferences={externalReferences}>
              {outro}
            </MarkdownBody>
          ) : null}
          {children ? (
            <section
              aria-labelledby={answerHeadingId}
              className="space-y-3 border-t border-border pt-4"
              data-testid="interaction-guide-answer"
            >
              <h3 id={answerHeadingId} className="text-sm font-semibold text-foreground">
                Your answer
              </h3>
              {children}
            </section>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

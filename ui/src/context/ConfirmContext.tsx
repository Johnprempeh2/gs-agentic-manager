import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { BrandMark } from "@/components/BrandMark";
import { cn } from "@/lib/utils";

export interface ConfirmOptions {
  /** The question, e.g. "Discard unsaved changes?" */
  title: string;
  /** Optional consequence or context under the title. */
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive actions get the danger button and a warning glyph. */
  tone?: "default" | "destructive";
}

export type ConfirmFn = (options: ConfirmOptions | string) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * A bare string keeps working as a drop-in for window.confirm: its last
 * paragraph is the question and anything before it becomes the description.
 */
function normalizeOptions(input: ConfirmOptions | string): ConfirmOptions {
  if (typeof input !== "string") return input;
  const paragraphs = input.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const title = paragraphs.pop() ?? input;
  return { title, description: paragraphs.length ? paragraphs.join("\n\n") : undefined };
}

function plainText(options: ConfirmOptions): string {
  return typeof options.description === "string" ? `${options.title} ${options.description}` : options.title;
}

/**
 * Outside the provider (isolated renders, tests) the native dialog answers, so
 * behaviour is unchanged there. Inside the app every confirmation is the
 * branded dialog below.
 */
const nativeConfirm: ConfirmFn = (input) => {
  if (typeof window === "undefined") return Promise.resolve(true);
  return Promise.resolve(window.confirm(plainText(normalizeOptions(input))));
};

/**
 * Branded replacement for window.confirm: the glass alert dialog with the
 * brand stone (or a warning glyph for destructive actions), promise based.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // Kept after closing so the dialog does not go blank while it animates out.
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const settle = useCallback((value: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOpen(false);
    resolve?.(value);
  }, []);

  const confirm = useCallback<ConfirmFn>((input) => {
    // A newer request replaces an unanswered one, which counts as a cancel.
    resolverRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setOptions(normalizeOptions(input));
      setOpen(true);
    });
  }, []);

  const destructive = options?.tone === "destructive";

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) settle(false);
        }}
      >
        <AlertDialogContent data-slot="confirm-dialog" className="sm:max-w-md">
          <div className="flex items-start gap-4">
            <div
              aria-hidden="true"
              className={cn(
                "gs-glass-card flex size-10 shrink-0 items-center justify-center rounded-xl border",
                destructive && "gs-confirm-danger",
              )}
            >
              {destructive ? (
                <AlertTriangle className="size-5 text-destructive" />
              ) : (
                <BrandMark decorative className="h-5 w-auto" />
              )}
            </div>
            <AlertDialogHeader className="min-w-0 gap-1.5 pt-0.5 text-left sm:text-left">
              <AlertDialogTitle className="text-base leading-snug">{options?.title}</AlertDialogTitle>
              {options?.description ? (
                <AlertDialogDescription className="whitespace-pre-line">{options.description}</AlertDialogDescription>
              ) : (
                <AlertDialogDescription className="sr-only">{options?.title}</AlertDialogDescription>
              )}
            </AlertDialogHeader>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>{options?.cancelLabel ?? "Cancel"}</AlertDialogCancel>
            <AlertDialogAction
              className={destructive ? buttonVariants({ variant: "destructive" }) : undefined}
              onClick={() => settle(true)}
            >
              {options?.confirmLabel ?? "Continue"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  return useMemo(() => confirm ?? nativeConfirm, [confirm]);
}

import { useCallback, useId, useRef, useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { ApiError, type RequestOptions } from "@/api/client";
import { REAUTH_HEADER, reauthApi, type ReauthAction } from "@/api/reauth";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The person closed the password prompt; the action did not run. */
export class ReauthCancelledError extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "ReauthCancelledError";
  }
}

function errorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const code = (error.body as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

export function isReauthRequired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && errorCode(error) === "reauth_required";
}

const ACTION_TEXT: Record<ReauthAction, string> = {
  release: "release a version",
  rollback: "roll back",
  promote: "promote a version",
};

/** `null` = retry with no header (`409 reauth_not_needed`). */
type ReauthOutcome = { token: string | null };

function reauthErrorText(error: unknown): string {
  const code = errorCode(error);
  if (code === "reauth_invalid_password") return "That password is not right. Try again.";
  if (code === "reauth_locked" || (error instanceof ApiError && error.status === 429)) {
    return "Too many wrong passwords. Try again in 15 minutes.";
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

/**
 * Runs an action and, when the server asks for the password again
 * (`403 reauth_required`), prompts for it and sends the same request once more
 * with the one-use `X-GSAM-Reauth` token. Render `dialog` once in the page.
 */
export function useReauth() {
  const [action, setAction] = useState<ReauthAction | null>(null);
  const resolverRef = useRef<((outcome: ReauthOutcome | null) => void) | null>(null);

  const settle = useCallback((outcome: ReauthOutcome | null) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setAction(null);
    resolve?.(outcome);
  }, []);

  const withReauth = useCallback(
    async <T,>(reauthAction: ReauthAction, run: (options?: RequestOptions) => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        if (!isReauthRequired(error)) throw error;
      }
      resolverRef.current?.(null);
      const outcome = await new Promise<ReauthOutcome | null>((resolve) => {
        resolverRef.current = resolve;
        setAction(reauthAction);
      });
      if (!outcome) throw new ReauthCancelledError();
      return run(outcome.token ? { headers: { [REAUTH_HEADER]: outcome.token } } : undefined);
    },
    [],
  );

  const dialog = <ReauthDialog action={action} onDone={settle} />;
  return { withReauth, dialog };
}

function ReauthDialog({
  action,
  onDone,
}: {
  action: ReauthAction | null;
  onDone: (outcome: ReauthOutcome | null) => void;
}) {
  const inputId = useId();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Kept while the dialog animates out so the text does not go blank.
  const [shownAction, setShownAction] = useState<ReauthAction>("release");
  if (action && action !== shownAction) setShownAction(action);

  const close = (outcome: ReauthOutcome | null) => {
    setPassword("");
    setError(null);
    setChecking(false);
    onDone(outcome);
  };

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!action || !password || checking) return;
    setChecking(true);
    setError(null);
    try {
      const { token } = await reauthApi.confirm(action, password);
      close({ token });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && errorCode(err) === "reauth_not_needed") {
        close({ token: null });
        return;
      }
      setChecking(false);
      setError(reauthErrorText(err));
    }
  }

  return (
    <AlertDialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) close(null);
      }}
    >
      <AlertDialogContent data-slot="reauth-dialog" className="sm:max-w-md">
        <form onSubmit={(event) => void onSubmit(event)} className="grid gap-4">
          <div className="flex items-start gap-4">
            <div
              aria-hidden="true"
              className="gs-glass-card flex size-10 shrink-0 items-center justify-center rounded-xl border"
            >
              <KeyRound className="size-5 text-muted-foreground" />
            </div>
            <AlertDialogHeader className="min-w-0 gap-1.5 pt-0.5 text-left sm:text-left">
              <AlertDialogTitle className="text-base leading-snug">Enter your password</AlertDialogTitle>
              <AlertDialogDescription>
                {`To ${ACTION_TEXT[shownAction]}, confirm it is you. The password is asked for each time.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={inputId}>Password</Label>
            <Input
              id={inputId}
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${inputId}-error` : undefined}
            />
            {error ? (
              <p id={`${inputId}-error`} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" onClick={() => close(null)}>
              Cancel
            </AlertDialogCancel>
            <Button type="submit" disabled={!password || checking}>
              {checking ? "Checking…" : "Continue"}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

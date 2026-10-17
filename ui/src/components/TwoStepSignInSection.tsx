import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import QRCode from "qrcode";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Setup = { totpURI: string; backupCodes: string[] };

/** The key inside an otpauth:// address, for people who type it in by hand. */
export function totpSecretFromUri(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get("secret");
  } catch {
    return null;
  }
}

/**
 * Profile > Two-step sign-in. Turning it on asks for the password, shows a QR
 * code for an authenticator app and ten backup codes, and is on only after the
 * first code from the app is confirmed. Turning it off asks for the password.
 */
export function TwoStepSignInSection() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: queryKeys.auth.twoStep, queryFn: () => authApi.getTwoStepStatus(), retry: false });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [mode, setMode] = useState<"idle" | "turning_on" | "turning_off">("idle");
  const [error, setError] = useState<string | null>(null);
  const [savedCodes, setSavedCodes] = useState<string[] | null>(null);

  useEffect(() => {
    if (!setup) {
      setQr(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(setup.totpURI, { margin: 1, width: 192 })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [setup]);

  const reset = () => {
    setPassword("");
    setCode("");
    setSetup(null);
    setMode("idle");
    setError(null);
  };

  const start = useMutation({
    mutationFn: () => authApi.startTwoStep(password),
    onSuccess: (result) => {
      setError(null);
      setPassword("");
      setSetup(result);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not start two-step sign-in"),
  });

  const confirm = useMutation({
    mutationFn: () => authApi.confirmTwoStep(code),
    onSuccess: async () => {
      const codes = setup?.backupCodes ?? null;
      reset();
      setSavedCodes(codes);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.twoStep });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "That code did not work"),
  });

  const turnOff = useMutation({
    mutationFn: () => authApi.turnOffTwoStep(password),
    onSuccess: async () => {
      reset();
      setSavedCodes(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.twoStep });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not turn off two-step sign-in"),
  });

  if (status.isLoading) return null;
  if (status.error || !status.data) {
    return (
      <section>
        <h2 className="text-sm font-semibold">Two-step sign-in</h2>
        <p role="alert" className="text-sm text-destructive">
          {status.error instanceof Error ? status.error.message : "Could not load two-step sign-in."}
        </p>
      </section>
    );
  }
  if (!status.data.available) return null;

  const enabled = status.data.enabled;
  // While an admin requires it, it cannot be turned off (the server refuses).
  const locked = enabled && status.data.required;
  const secret = setup ? totpSecretFromUri(setup.totpURI) : null;
  const busy = start.isPending || confirm.isPending || turnOff.isPending;

  return (
    <section className="space-y-4" aria-labelledby="two-step-heading">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <h2 id="two-step-heading" className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="size-4 text-muted-foreground" />
            Two-step sign-in {enabled ? "is on" : "is off"}
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            After your password, sign-in also asks for a 6-digit code from an authenticator app on your phone (for
            example Google Authenticator, Microsoft Authenticator or 1Password). Someone who learns your password still
            cannot get in.
          </p>
          {locked ? (
            <p className="max-w-2xl text-sm text-muted-foreground">
              An admin requires two-step sign-in on this instance, so it stays on. If you lose your phone and your
              backup codes, ask an admin to reset it.
            </p>
          ) : null}
        </div>
        {mode === "idle" && !locked ? (
          <Button
            type="button"
            variant={enabled ? "outline" : "default"}
            onClick={() => {
              setError(null);
              setSavedCodes(null);
              setMode(enabled ? "turning_off" : "turning_on");
            }}
          >
            {enabled ? "Turn off" : "Turn on"}
          </Button>
        ) : null}
      </div>

      {savedCodes ? (
        <div className="space-y-2 rounded-md border border-border p-4">
          <p className="text-sm font-medium">Two-step sign-in is on. Save these backup codes now.</p>
          <p className="text-sm text-muted-foreground">
            Each code signs you in once if you lose your phone. They are not shown again.
          </p>
          <BackupCodes codes={savedCodes} />
          <Button type="button" variant="outline" onClick={() => setSavedCodes(null)}>
            I have saved them
          </Button>
        </div>
      ) : null}

      {mode !== "idle" && !setup ? (
        <form
          className="flex max-w-md flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!password || busy) return;
            if (mode === "turning_on") start.mutate();
            else turnOff.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="two-step-password">Your password</Label>
            <Input
              id="two-step-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
            />
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={reset} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!password || busy}>
              {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {mode === "turning_on" ? "Continue" : "Turn off two-step sign-in"}
            </Button>
          </div>
        </form>
      ) : null}

      {setup ? (
        <div className="space-y-4 rounded-md border border-border p-4">
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li>
              Open your authenticator app, add an account, and scan this code.
              {qr ? <img src={qr} alt="QR code for your authenticator app" className="mt-2 size-48 rounded-md bg-background" /> : null}
              {secret ? (
                <p className="mt-2 text-muted-foreground">
                  Cannot scan? Type this key instead: <code className="break-all font-mono text-foreground">{secret}</code>
                </p>
              ) : null}
            </li>
            <li>
              Save your backup codes somewhere safe, such as a password manager. Each one signs you in once if you lose
              your phone.
              <BackupCodes codes={setup.backupCodes} />
            </li>
            <li>Type the 6-digit code the app shows now, to finish.</li>
          </ol>
          <form
            className="flex max-w-md flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (code.replace(/\s+/g, "").length < 6 || busy) return;
              confirm.mutate();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="two-step-confirm-code">Code from the app</Label>
              <Input
                id="two-step-confirm-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={reset} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={code.replace(/\s+/g, "").length < 6 || busy}>
                {confirm.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
                Turn on
              </Button>
            </div>
          </form>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <ul className="mt-2 grid max-w-md grid-cols-2 gap-1 font-mono text-sm" aria-label="Backup codes">
      {codes.map((backupCode) => (
        <li key={backupCode}>{backupCode}</li>
      ))}
    </ul>
  );
}

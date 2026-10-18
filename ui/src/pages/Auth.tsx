import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PASSWORD_RULE_HINT, passwordProblem } from "@greatstone/shared";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { getRememberedInvitePath } from "../lib/invite-memory";
import { Button } from "@/components/ui/button";
import { BrandTideHero } from "@/components/BrandTideHero";
import { BrandLoading } from "@/components/BrandLoading";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BrandLockup, PoweredByGreatstone } from "../components/BrandLockup";
import { getPartnerBranding, getProductName } from "../lib/partner-branding";

type AuthMode = "sign_in" | "sign_up";
type SignInStep = "password" | "code";

export function AuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>("sign_in");
  // `?step=code` comes from the invite page after a right password for a
  // person with two-step sign-in on.
  const [step, setStep] = useState<SignInStep>(() => (searchParams.get("step") === "code" ? "code" : "password"));
  const [code, setCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const errorId = "auth-error";

  const nextPath = useMemo(
    () => searchParams.get("next") || getRememberedInvitePath() || "/",
    [searchParams],
  );
  const { data: session, isLoading: isSessionLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  useEffect(() => {
    if (session) {
      navigate(nextPath, { replace: true });
    }
  }, [session, navigate, nextPath]);

  const mutation = useMutation({
    mutationFn: async (): Promise<{ twoFactorRequired: boolean }> => {
      if (mode === "sign_in" && step === "code") {
        await authApi.verifyTwoStepCode({ code, trustDevice, backup: useBackupCode });
        return { twoFactorRequired: false };
      }
      if (mode === "sign_in") {
        return authApi.signInEmail({ email: email.trim(), password });
      }
      await authApi.signUpEmail({
        name: name.trim(),
        email: email.trim(),
        password,
      });
      return { twoFactorRequired: false };
    },
    onSuccess: async (result) => {
      setError(null);
      if (result?.twoFactorRequired) {
        setPassword("");
        setStep("code");
        return;
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      // Reset rather than invalidate: the `["companies"]` entry is shared app-wide and
      // is not account-scoped, so invalidating leaves the previous account's list
      // readable (and any fetch for that session in flight) until the refetch lands.
      // Sign-in can change accounts, so drop the list outright.
      await queryClient.resetQueries({ queryKey: queryKeys.companies.all });
      navigate(nextPath, { replace: true });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Authentication failed");
    },
  });

  const productName = getProductName();
  const partnerBranded = getPartnerBranding() !== null;

  const canSubmit = step === "code" && mode === "sign_in"
    ? code.replace(/\s+/g, "").length >= 6
    : email.trim().length > 0 &&
    password.trim().length > 0 &&
    (mode === "sign_in" || (name.trim().length > 0 && !passwordProblem(password, { email })));

  if (isSessionLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <BrandLoading className="min-h-0" />
      </div>
    );
  }

  return (
    <div className="gs-onboarding-ground fixed inset-0 flex">
      <div className="absolute top-4 right-4 z-raised">
        {/* On a partner panel the toggle sits on the partner colour (md and up). */}
        <ThemeToggle className={partnerBranded ? "md:text-primary-foreground" : undefined} />
      </div>
      {/* Left half — form */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className={partnerBranded ? "mb-8 flex flex-col items-start gap-1.5" : "mb-8"}>
            <BrandLockup className="h-5 text-base" />
            <PoweredByGreatstone />
          </div>

          {step === "code" && mode === "sign_in" ? (
            <TwoStepCodeForm
              code={code}
              onCodeChange={setCode}
              useBackupCode={useBackupCode}
              onToggleBackupCode={() => {
                setError(null);
                setCode("");
                setUseBackupCode(!useBackupCode);
              }}
              trustDevice={trustDevice}
              onTrustDeviceChange={setTrustDevice}
              error={error}
              errorId={errorId}
              pending={mutation.isPending}
              canSubmit={canSubmit}
              onSubmit={() => {
                if (mutation.isPending) return;
                if (!canSubmit) {
                  setError(useBackupCode ? "Enter one of your backup codes." : "Enter the 6-digit code.");
                  return;
                }
                mutation.mutate();
              }}
              onStartAgain={() => {
                setError(null);
                setCode("");
                setStep("password");
              }}
            />
          ) : (
          <>
          <h1 className="text-xl font-semibold">
            {mode === "sign_in" ? `Sign in to ${productName}` : `Create your ${productName} account`}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "sign_in"
              ? "Use your email and password to access this instance."
              : "Create an account for this instance. Email confirmation is not required in v1."}
          </p>

          <form
            className="mt-6 space-y-4"
            method="post"
            action={mode === "sign_up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email"}
            onSubmit={(event) => {
              event.preventDefault();
              if (mutation.isPending) return;
              if (!canSubmit) {
                const weak = mode === "sign_up" && password.length > 0 ? passwordProblem(password, { email }) : null;
                setError(weak ?? "Please fill in all required fields.");
                return;
              }
              mutation.mutate();
            }}
          >
            {mode === "sign_up" && (
              <div>
                <label htmlFor="name" className="text-xs text-muted-foreground mb-1 block">Name</label>
                <input
                  id="name"
                  name="name"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-subtle-foreground"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  required
                  aria-required="true"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  autoFocus
                />
              </div>
            )}
            <div>
              <label htmlFor="email" className="text-xs text-muted-foreground mb-1 block">Email</label>
              <input
                id="email"
                name="email"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-subtle-foreground"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                required
                aria-required="true"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                autoFocus={mode === "sign_in"}
              />
            </div>
            <div>
              <label htmlFor="password" className="text-xs text-muted-foreground mb-1 block">Password</label>
              <input
                id="password"
                name="password"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-subtle-foreground"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
                required
                aria-required="true"
                aria-invalid={error ? true : undefined}
                aria-describedby={[error ? errorId : null, mode === "sign_up" ? "password-rule" : null].filter(Boolean).join(" ") || undefined}
              />
              {mode === "sign_up" && (
                <p id="password-rule" className="mt-1 text-xs text-muted-foreground">{PASSWORD_RULE_HINT}</p>
              )}
            </div>
            {error && (
              <p id={errorId} role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={mutation.isPending}
              aria-disabled={!canSubmit || mutation.isPending}
              className={`w-full ${!canSubmit && !mutation.isPending ? "opacity-50" : ""}`}
            >
              {mutation.isPending
                ? "Working…"
                : mode === "sign_in"
                  ? "Sign In"
                  : "Create Account"}
            </Button>
          </form>

          <div className="mt-5 text-sm text-muted-foreground">
            {mode === "sign_in" ? "Need an account?" : "Already have an account?"}{" "}
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() => {
                setError(null);
                setMode(mode === "sign_in" ? "sign_up" : "sign_in");
              }}
            >
              {mode === "sign_in" ? "Create one" : "Sign in"}
            </button>
          </div>
          </>
          )}
        </div>
      </div>

      {/* Right half: the Greatstone tide with the stone (hidden on mobile). A
          partner-branded instance gets a plain panel in its own colour. */}
      <div className="hidden md:block w-1/2 overflow-hidden">
        {partnerBranded ? <div className="h-full w-full bg-primary" data-slot="partner-auth-panel" /> : <BrandTideHero />}
      </div>
    </div>
  );
}

function TwoStepCodeForm(props: {
  code: string;
  onCodeChange: (value: string) => void;
  useBackupCode: boolean;
  onToggleBackupCode: () => void;
  trustDevice: boolean;
  onTrustDeviceChange: (value: boolean) => void;
  error: string | null;
  errorId: string;
  pending: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
  onStartAgain: () => void;
}) {
  return (
    <>
      <h1 className="text-xl font-semibold">Enter your sign-in code</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {props.useBackupCode
          ? "Type one of the backup codes you saved when you turned on two-step sign-in. Each code works once."
          : "Open your authenticator app and type the 6-digit code it shows for GSAM."}
      </p>
      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit();
        }}
      >
        <div>
          <label htmlFor="two-step-code" className="text-xs text-muted-foreground mb-1 block">
            {props.useBackupCode ? "Backup code" : "Code"}
          </label>
          <input
            id="two-step-code"
            name="code"
            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-subtle-foreground"
            value={props.code}
            onChange={(event) => props.onCodeChange(event.target.value)}
            inputMode={props.useBackupCode ? "text" : "numeric"}
            autoComplete="one-time-code"
            maxLength={props.useBackupCode ? 40 : 8}
            required
            aria-required="true"
            aria-invalid={props.error ? true : undefined}
            aria-describedby={props.error ? props.errorId : undefined}
            autoFocus
          />
        </div>
        <label className="flex items-start gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            name="trustDevice"
            checked={props.trustDevice}
            onChange={(event) => props.onTrustDeviceChange(event.target.checked)}
            className="mt-0.5 accent-primary"
          />
          <span>Do not ask again on this device for 30 days</span>
        </label>
        {props.error && (
          <p id={props.errorId} role="alert" className="text-xs text-destructive">
            {props.error}
          </p>
        )}
        <Button
          type="submit"
          disabled={props.pending}
          aria-disabled={!props.canSubmit || props.pending}
          className={`w-full ${!props.canSubmit && !props.pending ? "opacity-50" : ""}`}
        >
          {props.pending ? "Checking…" : "Sign In"}
        </Button>
      </form>
      <div className="mt-5 flex flex-col items-start gap-2 text-sm text-muted-foreground">
        <button
          type="button"
          className="font-medium text-foreground underline underline-offset-2"
          onClick={props.onToggleBackupCode}
        >
          {props.useBackupCode ? "Use the code from my app" : "I cannot use my app: use a backup code"}
        </button>
        <button
          type="button"
          className="font-medium text-foreground underline underline-offset-2"
          onClick={props.onStartAgain}
        >
          Start again
        </button>
      </div>
    </>
  );
}

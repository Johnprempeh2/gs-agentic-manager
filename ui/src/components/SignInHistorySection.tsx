import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { authApi, type SignInAttempt } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { relativeTime } from "@/lib/utils";
import { describeDevice } from "@/components/SignedInDevicesSection";

const OUTCOME_LABEL: Record<SignInAttempt["outcome"], string> = {
  signed_in: "Signed in",
  wrong_password: "Wrong password",
  code_needed: "Right password, two-step code not given",
};

/**
 * Profile > Recent sign-ins. Each attempt on this account with its device,
 * address and time. A wrong password, or a right password that never got its
 * two-step code, from somewhere the person does not recognise means someone
 * else is trying the account.
 */
export function SignInHistorySection() {
  const history = useQuery({
    queryKey: queryKeys.auth.signInHistory,
    queryFn: () => authApi.listSignInHistory(),
    retry: false,
  });

  if (history.isLoading) return null;
  const rows = history.data ?? [];
  const warnings = rows.filter((row) => row.outcome !== "signed_in").length;

  return (
    <section className="space-y-4" aria-labelledby="sign-in-history-heading">
      <div className="space-y-1.5">
        <h2 id="sign-in-history-heading" className="flex items-center gap-2 text-sm font-semibold">
          <History className="size-4 text-muted-foreground" />
          Recent sign-ins
        </h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {warnings > 0
            ? `${warnings} of these did not finish signing in. If they were not you, change your password and turn on two-step sign-in.`
            : "Every attempt to sign in to your account, for the last 90 days."}
        </p>
      </div>
      {rows.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
              <div className="min-w-0 space-y-0.5">
                <div className={row.outcome === "signed_in" ? "font-medium" : "font-medium text-destructive"}>
                  {OUTCOME_LABEL[row.outcome] ?? row.outcome}
                </div>
                <div className="text-muted-foreground">
                  {describeDevice(row.userAgent)}
                  {row.ipAddress ? ` · ${row.ipAddress}` : ""}
                </div>
              </div>
              <span className="shrink-0 text-muted-foreground">{relativeTime(row.at)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No sign-ins recorded yet.</p>
      )}
      {history.error ? (
        <p role="alert" className="text-sm text-destructive">
          {history.error instanceof Error ? history.error.message : "Could not load recent sign-ins."}
        </p>
      ) : null}
    </section>
  );
}

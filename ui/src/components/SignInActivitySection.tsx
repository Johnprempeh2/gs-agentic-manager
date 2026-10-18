import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { ApiError } from "@/api/client";
import { instanceSettingsApi, type InstanceSignInActivity } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { relativeTime } from "@/lib/utils";
import { describeDevice } from "@/components/SignedInDevicesSection";

const OUTCOME_LABEL: Record<InstanceSignInActivity["events"][number]["outcome"], string> = {
  wrong_password: "Wrong password",
  code_needed: "Right password, two-step code not given",
};

/**
 * Settings > Security > Sign-in activity, for the instance admin. Wrong
 * passwords and passwords held at the two-step code on any account, with
 * counts for the last day, so someone guessing (or holding a leaked password)
 * shows up. Hidden from anyone who is not an instance admin.
 */
export function SignInActivitySection() {
  const activity = useQuery({
    queryKey: queryKeys.instance.signInActivity,
    queryFn: () => instanceSettingsApi.getSignInActivity(),
    retry: false,
  });

  if (activity.isLoading) return null;
  if (activity.error instanceof ApiError && (activity.error.status === 403 || activity.error.status === 401)) return null;

  const counts = activity.data?.counts;
  const events = activity.data?.events ?? [];

  return (
    <section className="space-y-4" aria-labelledby="sign-in-activity-heading">
      <div className="space-y-1.5">
        <h2 id="sign-in-activity-heading" className="flex items-center gap-2 text-sm font-semibold">
          <ShieldAlert className="size-4 text-muted-foreground" />
          Sign-in activity
        </h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {counts
            ? `Last 24 hours: ${counts.signedIn} sign-ins, ${counts.wrongPassword} wrong passwords, ${counts.codeNeeded} stopped at the two-step code.`
            : "Sign-in attempts that did not finish, on every account."}
        </p>
      </div>
      {events.length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {events.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
              <div className="min-w-0 space-y-0.5">
                <div className="font-medium">
                  {row.user.name || row.user.email || "Unknown person"}
                  <span className="text-destructive"> · {OUTCOME_LABEL[row.outcome] ?? row.outcome}</span>
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
      ) : activity.data ? (
        <p className="text-sm text-muted-foreground">No failed sign-ins recorded.</p>
      ) : null}
      {activity.error ? (
        <p role="alert" className="text-sm text-destructive">
          {activity.error instanceof Error ? activity.error.message : "Could not load sign-in activity."}
        </p>
      ) : null}
    </section>
  );
}

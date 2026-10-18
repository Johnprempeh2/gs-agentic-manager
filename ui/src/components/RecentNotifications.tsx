import { useQuery } from "@tanstack/react-query";
import { pushApi } from "../api/push";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";
import { Link } from "@/lib/router";

/**
 * What reached this person's phones in the last two weeks, newest first, so a
 * notification swiped away by mistake is never lost. Each line opens what the
 * notification opened.
 */
export function RecentNotifications({ companyId }: { companyId: string }) {
  const { data, error } = useQuery({
    queryKey: queryKeys.recentNotifications(companyId),
    queryFn: () => pushApi.recent(companyId),
  });

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4" data-testid="recent-notifications">
      <div className="space-y-0.5">
        <h2 className="text-base font-semibold">Recent notifications</h2>
        <p className="text-sm text-muted-foreground">What reached your phone in the last two weeks. Tap one to open it again.</p>
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">Could not load your recent notifications.</p>
      ) : !data ? null : data.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet. Notifications show here once they reach your phone.</p>
      ) : (
        <ul className="divide-y divide-border">
          {data.map((item) => (
            <li key={item.id}>
              <Link to={item.url} className="flex min-h-11 items-start gap-3 py-2 hover:bg-accent/50">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{item.title}</span>
                  <span className="block truncate text-sm text-muted-foreground">{item.body}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(item.sentAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

import { useIssueFollows } from "../hooks/useIssueFollows";
import { followProgressLabel } from "./FollowTask";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarSection } from "./SidebarSection";

/**
 * "Following" in the sidebar: each followed task with how far its whole
 * subtree has got, one click away. Hidden until the user follows something.
 */
export function SidebarFollowing({ companyId }: { companyId: string | null | undefined }) {
  const { follows } = useIssueFollows(companyId);
  if (follows.length === 0) return null;

  return (
    <SidebarSection label="Following">
      {follows.map(({ issueId, issue, counts }) => {
        const progress = followProgressLabel(counts);
        const waiting = counts.waitingOnYou > 0 ? `, ${counts.waitingOnYou} waiting on you` : "";
        return (
          <SidebarNavItem
            key={issueId}
            to={`/issues/${issue.identifier ?? issueId}`}
            label={issue.title}
            trailing={(
              <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground" data-sidebar-follow-progress>
                {counts.waitingOnYou > 0 ? (
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-status-alert" />
                ) : null}
                <span aria-hidden="true">{counts.done}/{counts.total}</span>
                <span className="sr-only">{`${progress}${waiting}`}</span>
              </span>
            )}
            trailingLabel={`${progress}${waiting}`}
          />
        );
      })}
    </SidebarSection>
  );
}

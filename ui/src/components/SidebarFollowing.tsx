import { useIssueFollows } from "../hooks/useIssueFollows";
import { followProgressLabel } from "./FollowTask";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarSection } from "./SidebarSection";

/**
 * "Pinned" in the sidebar (follows in the API): each pinned task with how far
 * its whole subtree has got, one click away. Hidden until the user pins one.
 */
export function SidebarFollowing({ companyId }: { companyId: string | null | undefined }) {
  const { follows } = useIssueFollows(companyId);
  if (follows.length === 0) return null;

  return (
    <SidebarSection label="Pinned">
      {follows.map(({ issueId, issue, counts }) => {
        const progress = followProgressLabel(counts);
        const waiting = counts.waitingOnYou > 0 ? `, ${counts.waitingOnYou} waiting on you` : "";
        return (
          <SidebarNavItem
            key={issueId}
            to={`/issues/${issue.identifier ?? issueId}`}
            label={issue.title}
            activeKey={[`pinned:${issueId}`, `pinned:${issue.identifier ?? issueId}`]}
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

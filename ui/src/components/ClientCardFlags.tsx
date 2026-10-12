import { Badge } from "@/components/ui/badge";
import {
  getClientCardFlags,
  NO_CONTACT_FLAG_DAYS,
  STUCK_STAGE_FLAG_DAYS,
  type ClientCardFlagInput,
} from "@/lib/client-card-flags";

function formatDays(days: number) {
  return days === 1 ? "1 day" : `${days} days`;
}

/** Badges for a client card on the pipeline board; renders nothing when no flag is due. */
export function ClientCardFlags({ caseItem, now }: { caseItem: ClientCardFlagInput; now?: Date }) {
  const { noContactDays, stuckStageDays } = getClientCardFlags(caseItem, now);
  return (
    <>
      {noContactDays != null ? (
        <Badge
          variant="outline"
          title={`No contact logged for ${NO_CONTACT_FLAG_DAYS} days or more`}
          className="border-rose-400/40 bg-rose-50 text-(length:--text-nano) text-rose-700 dark:border-rose-300/30 dark:bg-rose-900/25 dark:text-rose-300"
        >
          No contact {formatDays(noContactDays)}
        </Badge>
      ) : null}
      {stuckStageDays != null ? (
        <Badge
          variant="outline"
          title={`No stage move for ${STUCK_STAGE_FLAG_DAYS} days or more`}
          className="border-amber-400/40 bg-amber-50 text-(length:--text-nano) text-amber-700 dark:border-amber-300/30 dark:bg-amber-900/25 dark:text-amber-300"
        >
          Same stage {formatDays(stuckStageDays)}
        </Badge>
      ) : null}
    </>
  );
}

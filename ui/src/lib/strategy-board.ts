import {
  KPI_STATUS_WORDS,
  boardAssurance,
  type BoardAssurance,
  type StrategyBoardOwner,
  type StrategyBoardPackListItem,
  type StrategyBoardSummary,
} from "@greatstone/shared";
import { formatCalendarDay } from "./utils";

// Evidence strength lives in shared, so the server's attention queue uses the same rule (GRE-1134).
export { ASSURANCE_FRESH_DAYS, ASSURANCE_STALE_DAYS, boardAssurance, type BoardAssurance } from "@greatstone/shared";

export const ASSURANCE_LABEL: Record<BoardAssurance, string> = {
  strong: "Strong evidence",
  moderate: "Moderate evidence",
  weak: "Weak evidence",
};

export function readingAgeText(days: number | null): string {
  if (days == null) return "no reading";
  if (days === 0) return "today";
  if (days === 1) return "1 day old";
  return `${days} days old`;
}

export function boardOwnerName(owner: StrategyBoardOwner | null): string {
  if (!owner) return "No owner";
  return owner.name ?? (owner.type === "agent" ? "An agent" : "A person");
}

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

function isoDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** The same day one month earlier, clamped to the month's end ("2026-03-31" gives "2026-02-28"). */
function oneMonthBefore(date: string): string {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 2, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/**
 * The default board pack period for a monthly board: from the day after the
 * last accepted pack ended (or one month back) to the next meeting (or
 * today). Falls back to one month when the last pack ends after the meeting.
 */
export function defaultPackPeriod(input: {
  lastPackEnd: string | null;
  nextMeetingDate: string | null;
  today: string;
}): { periodStart: string; periodEnd: string; title: string } {
  const periodEnd = input.nextMeetingDate ?? input.today;
  const afterLast = input.lastPackEnd ? isoDay(dayNumber(input.lastPackEnd) + 1) : null;
  const periodStart = afterLast && afterLast <= periodEnd ? afterLast : oneMonthBefore(periodEnd);
  const month = new Date(`${periodEnd}T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return { periodStart, periodEnd, title: `${month} board pack` };
}

/** "Next board meeting: 12 Nov (in 3 days)"; null when none is set or the date has passed. */
export function nextMeetingText(nextMeetingDate: string | null, today: string): string | null {
  if (!nextMeetingDate) return null;
  const days = dayNumber(nextMeetingDate) - dayNumber(today);
  if (days < 0) return null;
  const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  return `Next board meeting: ${formatCalendarDay(nextMeetingDate)} (${when})`;
}

/** Saves a board pack as a Markdown file the board can open or print. */
export function downloadMarkdown(fileName: string, body: string) {
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function packFileName(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug || "board-pack"}.md`;
}

/**
 * The meeting's pack (GRE-1200): the newest accepted pack. A draft from the
 * board secretary agent never counts until a board member accepts it.
 */
export function meetingPackId(packs: readonly Pick<StrategyBoardPackListItem, "id" | "status" | "createdAt">[]): string | null {
  let best: (typeof packs)[number] | null = null;
  for (const pack of packs) {
    if (pack.status !== "accepted") continue;
    if (!best || new Date(pack.createdAt).getTime() > new Date(best.createdAt).getTime()) best = pack;
  }
  return best?.id ?? null;
}

/**
 * "Copy as an update" on the board panel: the headline, then what needs the
 * board and the overdue actions, ready to paste into an email to the board.
 */
export function boardUpdateText(
  board: Pick<StrategyBoardSummary, "asOf" | "attention" | "overdueActions">,
  lede: string,
): string {
  const lines = [`Board update, as of ${formatCalendarDay(board.asOf)}`, lede];
  if (board.attention.length > 0) {
    lines.push("", "Needs board attention");
    for (const kpi of board.attention) {
      const parts = [
        kpi.status ? KPI_STATUS_WORDS[kpi.status] : `Not measured${kpi.notMeasuredReason ? ` (${kpi.notMeasuredReason.toLowerCase()})` : ""}`,
        kpi.gapPercent ? `${Math.round(kpi.gapPercent)}% behind plan` : null,
        boardOwnerName(kpi.owner),
      ].filter(Boolean);
      lines.push(`• ${kpi.title}: ${parts.join(", ")}`);
    }
  } else {
    lines.push("", "Nothing needs board attention.");
  }
  if (board.overdueActions.length > 0) {
    lines.push("", "Overdue actions");
    for (const action of board.overdueActions) {
      const late = action.daysOverdue === 1 ? "1 day overdue" : `${action.daysOverdue} days overdue`;
      lines.push(`• ${action.title}: ${late}, ${boardOwnerName(action.owner)}`);
    }
  }
  return lines.join("\n");
}

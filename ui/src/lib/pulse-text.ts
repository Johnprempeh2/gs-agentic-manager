import type { DailyPulseSections } from "@greatstone/shared";
import { formatCalendarDay } from "./utils";

/**
 * "Copy the Pulse" on Intelligence: the Daily Pulse as plain text with its
 * links, ready to paste into a team chat or an email.
 */
export function pulseText(pulse: { sections: DailyPulseSections; headline: string | null; reportDate: string }): string {
  const { sections } = pulse;
  const lines = [`Daily Pulse, ${formatCalendarDay(pulse.reportDate, { includeYear: true })}`];
  if (pulse.headline) lines.push(pulse.headline);
  const quickWin = sections.quickWin;
  lines.push("", `Quick win (${quickWin.timeNeeded}): ${quickWin.title}`, quickWin.action, quickWin.outcome);
  if (quickWin.url) lines.push(quickWin.url);
  if (sections.weekInReview) lines.push("", "Week in review", sections.weekInReview);
  const list = <T,>(title: string, items: readonly T[], line: (item: T) => string) => {
    if (items.length === 0) return;
    lines.push("", title);
    for (const item of items) lines.push(`• ${line(item)}`);
  };
  list("AI industry trends", sections.trends, (trend) => `${trend.headline} (${trend.sourceName}): ${trend.whyItMatters} ${trend.url}`);
  list("Trending tools", sections.tools, (tool) => `${tool.name}: ${tool.what} ${tool.url}`);
  list("Skill ideas", sections.skillIdeas, (idea) => `${idea.name}: ${idea.what}`);
  list("Creator content", sections.creators, (item) => `${item.creator} (${item.platform}): ${item.content} ${item.url}`);
  list("Greatstone opportunities", sections.opportunities, (item) => `${item.title}: ${item.nextStep}`);
  return lines.join("\n");
}

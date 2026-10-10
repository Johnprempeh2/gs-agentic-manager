import type { StrategyBoardKpi, StrategyBoardOwner } from "@greatstone/shared";

/**
 * How far the board can trust a KPI's number, shown apart from its colour
 * (Mikey's design view, GRE-1134): a green KPI may rest on weak evidence.
 * - strong: checked by an agent or taken from a system, and at most 14 days old
 * - weak: reported by the owner only, or older than 30 days, or no reading
 * - moderate: anything in between
 */
export type BoardAssurance = "strong" | "moderate" | "weak";

export const ASSURANCE_FRESH_DAYS = 14;
export const ASSURANCE_STALE_DAYS = 30;

export function boardAssurance(kpi: Pick<StrategyBoardKpi, "latestReadingSource" | "readingAgeDays">): BoardAssurance {
  if (!kpi.latestReadingSource || kpi.readingAgeDays == null) return "weak";
  if (kpi.readingAgeDays > ASSURANCE_STALE_DAYS) return "weak";
  if (kpi.latestReadingSource === "owner_reported") return "weak";
  return kpi.readingAgeDays <= ASSURANCE_FRESH_DAYS ? "strong" : "moderate";
}

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

/** The last full calendar quarter before `today`, as the default board pack period. */
export function previousQuarter(today: Date = new Date()): { periodStart: string; periodEnd: string; label: string } {
  const year = today.getUTCFullYear();
  const quarter = Math.floor(today.getUTCMonth() / 3); // 0-based current quarter
  const prevQuarter = (quarter + 3) % 4;
  const prevYear = quarter === 0 ? year - 1 : year;
  const start = new Date(Date.UTC(prevYear, prevQuarter * 3, 1));
  const end = new Date(Date.UTC(prevYear, prevQuarter * 3 + 3, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { periodStart: iso(start), periodEnd: iso(end), label: `Q${prevQuarter + 1} ${prevYear}` };
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

import { GREATSTONE_TEAM_TAG, type CatalogTeam } from "@greatstone/shared";

/**
 * "Pick your first team" (GRE-427): the Greatstone department teams a new
 * company can start with, grouped by department (`category`) and sorted so the
 * teams recommended for the chosen industry (`recommendedForCompanyTypes`)
 * come first.
 */

export interface FirstTeamGroup {
  category: string;
  label: string;
  teams: CatalogTeam[];
}

/** Only installable Greatstone teams are offered as a first team. */
export function firstTeamCandidates(teams: readonly CatalogTeam[]): CatalogTeam[] {
  return teams.filter(
    (team) =>
      team.tags.includes(GREATSTONE_TEAM_TAG) &&
      team.compatibility === "compatible" &&
      team.trustLevel !== "scripts_executables",
  );
}

/** The industries the offered teams name, for the industry chooser. Sorted, no duplicates. */
export function firstTeamIndustries(teams: readonly CatalogTeam[]): string[] {
  return Array.from(new Set(teams.flatMap((team) => team.recommendedForCompanyTypes))).sort();
}

/** "small-business" -> "Small business". */
export function humanizeCatalogValue(value: string): string {
  const words = value.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function fitsIndustry(team: CatalogTeam, industry: string | null): boolean {
  return industry !== null && team.recommendedForCompanyTypes.includes(industry);
}

/**
 * Group teams by department. With an industry chosen, departments holding a
 * team for that industry come first, and within each department those teams
 * lead. Ties fall back to name order so the grid never reshuffles at random.
 */
export function groupFirstTeams(
  teams: readonly CatalogTeam[],
  industry: string | null,
): FirstTeamGroup[] {
  const byCategory = new Map<string, CatalogTeam[]>();
  for (const team of teams) {
    const bucket = byCategory.get(team.category) ?? [];
    bucket.push(team);
    byCategory.set(team.category, bucket);
  }
  const rank = (team: CatalogTeam) => (fitsIndustry(team, industry) ? 0 : 1);
  return Array.from(byCategory.entries())
    .map(([category, members]) => ({
      category,
      label: humanizeCatalogValue(category),
      teams: [...members].sort(
        (left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name),
      ),
    }))
    .sort((left, right) => {
      const leftFits = left.teams.some((team) => fitsIndustry(team, industry)) ? 0 : 1;
      const rightFits = right.teams.some((team) => fitsIndustry(team, industry)) ? 0 : 1;
      return leftFits - rightFits || left.label.localeCompare(right.label);
    });
}

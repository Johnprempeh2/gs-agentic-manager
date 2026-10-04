import { useMemo } from "react";
import type { CatalogTeam } from "@greatstone/shared";
import { Ban } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TeamCard } from "../../pages/TeamCatalog";
import { cn } from "../../lib/utils";
import { firstTeamIndustries, groupFirstTeams, humanizeCatalogValue } from "./first-team";

const ANY_INDUSTRY = "__any__";

/**
 * "Pick your first team" (GRE-427). The Greatstone department teams as tiles,
 * grouped by department and sorted by the industry chosen above them, with a
 * "Start with no team" tile that is selected while nothing else is.
 *
 * Selection only: the team is installed when the run finishes, once the lead
 * agent it reports to exists.
 */
export function FirstTeamStep({
  teams,
  loading,
  failed,
  industry,
  onIndustryChange,
  selectedTeamId,
  onSelectTeam,
}: {
  teams: CatalogTeam[];
  loading: boolean;
  failed: boolean;
  industry: string | null;
  onIndustryChange: (industry: string | null) => void;
  selectedTeamId: string | null;
  onSelectTeam: (teamId: string | null) => void;
}) {
  const industries = useMemo(() => firstTeamIndustries(teams), [teams]);
  const groups = useMemo(() => groupFirstTeams(teams, industry), [teams, industry]);

  return (
    <div className="flex flex-col gap-6" data-testid="first-team-step">
      {industries.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="onboarding-industry">Your industry</Label>
          <Select
            value={industry ?? ANY_INDUSTRY}
            onValueChange={(value) => onIndustryChange(value === ANY_INDUSTRY ? null : value)}
          >
            <SelectTrigger id="onboarding-industry" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_INDUSTRY}>Any industry</SelectItem>
              {industries.map((value) => (
                <SelectItem key={value} value={value}>
                  {humanizeCatalogValue(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {loading && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="aspect-square w-full rounded-lg" />
          <Skeleton className="aspect-square w-full rounded-lg" />
        </div>
      )}

      {failed && (
        <p className="text-sm text-muted-foreground">
          The team list could not load. You can start with no team and add one later from Team Catalogue.
        </p>
      )}

      {/* One cell per department: most departments hold one team, so a grid
          of departments stays compact where a grid per department would
          leave every second column empty. */}
      {groups.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {groups.map((group) => (
            <section key={group.category} className="flex flex-col gap-2" aria-label={group.label}>
              <h2 className="text-sm font-medium text-foreground">{group.label}</h2>
              {group.teams.map((team) => (
                <TeamCard
                  key={team.id}
                  team={team}
                  selected={selectedTeamId === team.id}
                  onSelect={() => onSelectTeam(selectedTeamId === team.id ? null : team.id)}
                />
              ))}
            </section>
          ))}
        </div>
      )}

      <button
        type="button"
        aria-pressed={selectedTeamId === null}
        onClick={() => onSelectTeam(null)}
        className={cn(
          // design-allow(card-pattern): interactive <button> option beside TeamCard tiles; same tile language
          "flex items-center gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selectedTeamId === null && "ring-2 ring-ring",
        )}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <Ban className="h-4 w-4 text-muted-foreground" />
        </span>
        <span className="flex flex-col">
          <span className="text-sm font-semibold">Start with no team</span>
          <span className="text-xs text-muted-foreground">Add a department later from Team Catalogue.</span>
        </span>
      </button>
    </div>
  );
}

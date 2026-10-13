import {
  INTELLIGENCE_BOARD_LABELS,
  type IntelligenceBoardHistory,
  type IntelligenceBoardMovement,
  type IntelligenceBoardRow,
  type IntelligenceBoardView,
} from "@greatstone/shared";
import { cn, formatCalendarDay } from "@/lib/utils";
import { MovementChip, SourceLink } from "./IntelligenceCards";

/** Lower-cased entry name to its score series, oldest first (nulls are gaps). */
export type ScoreSeries = Map<string, (number | null)[]>;

export function seriesFor(history: IntelligenceBoardHistory | undefined): ScoreSeries {
  const series: ScoreSeries = new Map();
  if (!history) return series;
  const names = new Set(history.points.flatMap((point) => Object.keys(point.scores)));
  for (const name of names) series.set(name, history.points.map((point) => point.scores[name] ?? null));
  return series;
}

const scoreLabel = (view: IntelligenceBoardView) => (view.board === "frontier_models" ? "Index" : "Score");

/** Score change since the compared snapshot, signed, in the status colours. */
export function ScoreDelta({ movement }: { movement: IntelligenceBoardMovement }) {
  const delta = movement.scoreDelta;
  if (!delta) return null;
  return (
    <span className={cn("text-xs font-medium tabular-nums", delta > 0 ? "text-status-success" : "text-status-danger")}>
      {delta > 0 ? "+" : ""}
      {delta}
    </span>
  );
}

/** Tiny score trend line. Renders nothing with fewer than two scored snapshots. */
export function Sparkline({ values, className }: { values: (number | null)[] | undefined; className?: string }) {
  const points = (values ?? []).flatMap((value, index) => (value === null ? [] : [[index, value] as const]));
  if (points.length < 2) return null;
  const width = 72;
  const height = 20;
  const scores = points.map(([, value]) => value);
  const min = Math.min(...scores);
  const span = Math.max(...scores) - min || 1;
  const last = (values?.length ?? 1) - 1 || 1;
  const coords = points.map(([index, value]) => `${((index / last) * (width - 2) + 1).toFixed(1)},${(height - 1 - ((value - min) / span) * (height - 2)).toFixed(1)}`);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={`Score history: ${scores[0]} to ${scores.at(-1)} over ${points.length} snapshots`}
      className={cn("shrink-0 text-chart-2", className)}
    >
      <polyline points={coords.join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Movement({ movement }: { movement: IntelligenceBoardMovement }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <MovementChip movement={movement} />
      <ScoreDelta movement={movement} />
    </span>
  );
}

function EntryName({ entry, className }: { entry: IntelligenceBoardRow; className?: string }) {
  return entry.url ? (
    <SourceLink href={entry.url} className={cn("text-foreground", className)}>
      {entry.name}
    </SourceLink>
  ) : (
    <span className={className}>{entry.name}</span>
  );
}

/** Top three as a podium: 2nd, 1st (raised), 3rd. Stays three columns on a phone. */
export function Podium({ view, series }: { view: IntelligenceBoardView; series?: ScoreSeries }) {
  const top = view.entries.slice(0, 3);
  // Podium order: 2nd, 1st, 3rd. `place` is the podium step, `rank` what the board says.
  const order = [1, 0, 2].flatMap((index) => (top[index] ? [{ entry: top[index], place: index + 1 }] : []));
  return (
    <ol className="grid grid-cols-3 items-end gap-2 sm:gap-3" aria-label={`${INTELLIGENCE_BOARD_LABELS[view.board]} top three`}>
      {order.map(({ entry, place }) => {
        const first = place === 1;
        return (
          <li
            key={entry.name}
            data-place={place}
            className={cn(
              "flex min-w-0 flex-col items-center gap-1 rounded-lg border bg-card px-2 pb-3 text-center sm:px-4",
              first ? "border-primary/50 pt-6 shadow-sm sm:pt-8" : "border-border pt-4",
            )}
          >
            <span
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold",
                first ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
              )}
            >
              <span className="sr-only">Rank </span>
              {entry.rank}
            </span>
            <EntryName
              entry={entry}
              className={cn("max-w-full break-words font-semibold leading-snug", first ? "text-sm sm:text-base" : "text-sm")}
            />
            {entry.maker || entry.flagship ? (
              <span className="max-w-full truncate text-xs text-muted-foreground">{entry.maker ?? entry.flagship}</span>
            ) : null}
            <span className={cn("font-bold tabular-nums", first ? "text-2xl sm:text-3xl" : "text-xl sm:text-2xl")}>
              {entry.score ?? "n/a"}
            </span>
            <span className="text-xs uppercase tracking-wide text-muted-foreground">{scoreLabel(view)}</span>
            <Movement movement={entry.movement} />
            <Sparkline values={series?.get(entry.name.toLowerCase())} className="mt-1 hidden sm:block" />
          </li>
        );
      })}
    </ol>
  );
}

/** One board: heading, podium, then ranks four onwards as a dense table. */
export function BoardSection({ view, series }: { view: IntelligenceBoardView; series?: ScoreSeries }) {
  const rest = view.entries.slice(3);
  const hasTrend = !!series && series.size > 0;
  return (
    <section className="space-y-3" aria-labelledby={`board-${view.board}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={`board-${view.board}`} className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {INTELLIGENCE_BOARD_LABELS[view.board]}
        </h2>
        <span className="text-xs text-muted-foreground">
          {formatCalendarDay(view.snapshotDate, { includeYear: true })}
          {view.comparedTo ? `, movement since ${formatCalendarDay(view.comparedTo)}` : ""}
        </span>
      </div>
      <Podium view={view} series={series} />
      {rest.length > 0 ? (
        <div className="rounded-lg border border-border">
          <table className="w-full table-fixed text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th scope="col" className="w-9 px-2 py-2 text-left font-medium sm:px-3">#</th>
                <th scope="col" className="px-2 py-2 text-left font-medium sm:px-3">Name</th>
                <th scope="col" className="w-20 px-2 py-2 text-left font-medium sm:w-24 sm:px-3">Move</th>
                <th scope="col" className="w-16 px-2 py-2 text-right font-medium sm:px-3">{scoreLabel(view)}</th>
                {hasTrend ? <th scope="col" className="hidden w-24 px-3 py-2 text-right font-medium sm:table-cell">Trend</th> : null}
              </tr>
            </thead>
            <tbody>
              {rest.map((entry) => (
                <tr key={entry.name} className="border-b border-border last:border-0">
                  <td className="px-2 py-1.5 font-mono text-xs text-muted-foreground sm:px-3">{entry.rank}</td>
                  <td className="min-w-0 px-2 py-1.5 sm:px-3">
                    <EntryName entry={entry} className="block break-words text-sm font-medium" />
                    {entry.maker || entry.verdict ? (
                      <div className="break-words text-xs text-muted-foreground">{[entry.maker, entry.verdict].filter(Boolean).join(". ")}</div>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5 sm:px-3"><Movement movement={entry.movement} /></td>
                  <td className="px-2 py-1.5 text-right tabular-nums sm:px-3">{entry.score ?? "n/a"}</td>
                  {hasTrend ? (
                    <td className="hidden px-3 py-1.5 sm:table-cell">
                      <div className="flex justify-end"><Sparkline values={series?.get(entry.name.toLowerCase())} /></div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

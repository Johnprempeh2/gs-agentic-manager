import type { ReleaseChangelog as ReleaseChangelogData } from "@/api/releases";
import { cn } from "@/lib/utils";

function ChangelogGroup({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <ul className="list-disc space-y-0.5 pl-5 text-sm text-foreground">
        {items.map((item, index) => (
          <li key={`${index}-${item}`} className="break-words">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A version's changelog: Features, then Fixes. */
export function ReleaseChangelog({ changelog, className }: { changelog: ReleaseChangelogData; className?: string }) {
  if (changelog.features.length === 0 && changelog.fixes.length === 0) {
    return <p className={cn("text-sm text-muted-foreground", className)}>No changelog for this version.</p>;
  }
  return (
    <div className={cn("space-y-3", className)}>
      <ChangelogGroup label="Features" items={changelog.features} />
      <ChangelogGroup label="Fixes" items={changelog.fixes} />
    </div>
  );
}

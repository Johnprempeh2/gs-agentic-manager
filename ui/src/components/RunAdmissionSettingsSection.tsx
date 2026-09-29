import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DEFAULT_RUN_ADMISSION_MAX_CONCURRENT_RUNS,
  DEFAULT_RUN_ADMISSION_MIN_AVAILABLE_MEMORY_MB,
  DEFAULT_RUN_ADMISSION_MIN_FREE_DISK_GB,
  type InstanceGeneralSettings,
} from "@greatstone/shared";
import { instanceSettingsApi, type RunAdmissionRecommendation } from "@/api/instanceSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { queryKeys } from "@/lib/queryKeys";
import {
  RAM_FLOOR_MAX_MB,
  RUN_CAP_MAX,
  RUN_CAP_MIN,
  describeRunCapSuggestion,
  formatGb,
  parseWholeNumber,
  runsFreeRamCanHold,
  suggestRunCap,
} from "@/lib/runAdmissionSuggestion";

type RunAdmission = NonNullable<InstanceGeneralSettings["runAdmission"]>;

const DISK_FLOOR_MAX_GB = 100_000;

export function RunAdmissionSettingsSection({
  runAdmission,
  disabled,
  onSave,
}: {
  runAdmission: InstanceGeneralSettings["runAdmission"];
  disabled: boolean;
  onSave: (next: Required<RunAdmission>) => void;
}) {
  const capId = useId();
  const floorId = useId();
  const diskId = useId();
  const savedCap = runAdmission?.maxConcurrentRuns ?? DEFAULT_RUN_ADMISSION_MAX_CONCURRENT_RUNS;
  const savedFloor = runAdmission?.minAvailableMemoryMb ?? DEFAULT_RUN_ADMISSION_MIN_AVAILABLE_MEMORY_MB;
  const [capInput, setCapInput] = useState(String(savedCap));
  const savedDiskFloor = runAdmission?.minFreeDiskGb ?? DEFAULT_RUN_ADMISSION_MIN_FREE_DISK_GB;
  const [floorInput, setFloorInput] = useState(String(savedFloor));
  const [diskInput, setDiskInput] = useState(String(savedDiskFloor));

  // Follow the saved values after a save or refetch.
  useEffect(() => setCapInput(String(savedCap)), [savedCap]);
  useEffect(() => setFloorInput(String(savedFloor)), [savedFloor]);
  useEffect(() => setDiskInput(String(savedDiskFloor)), [savedDiskFloor]);

  const memoryQuery = useQuery({
    queryKey: queryKeys.instance.systemMemory,
    queryFn: () => instanceSettingsApi.getSystemMemory(),
    retry: false,
  });

  const recommendationQuery = useQuery({
    queryKey: queryKeys.instance.runAdmissionRecommendation,
    queryFn: () => instanceSettingsApi.getRunAdmissionRecommendation(),
    retry: false,
  });
  const recommendation = recommendationQuery.data;
  // With no runs or holds yet, the RAM-based suggestion above is all there is.
  const hasUsage = recommendation
    ? recommendation.usage.runsStarted > 0 ||
      recommendation.usage.holds.globalCap.runs > 0 ||
      recommendation.usage.holds.lowMemory.runs > 0
    : false;

  const cap = parseWholeNumber(capInput, RUN_CAP_MIN, RUN_CAP_MAX);
  const floor = parseWholeNumber(floorInput, 0, RAM_FLOOR_MAX_MB);
  const diskFloor = parseWholeNumber(diskInput, 0, DISK_FLOOR_MAX_GB);
  const dirty = cap !== savedCap || floor !== savedFloor || diskFloor !== savedDiskFloor;
  const canSave = !disabled && dirty && cap !== null && floor !== null && diskFloor !== null;
  // The suggestion follows the floor being typed, falling back to the saved one.
  const suggestionFloor = floor ?? savedFloor;
  const memory = memoryQuery.data;
  const suggestedCap = memory ? suggestRunCap(memory.totalBytes, suggestionFloor) : null;

  return (
    <section>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave || cap === null || floor === null || diskFloor === null) return;
          // Send every field: the server replaces the whole runAdmission object.
          onSave({ maxConcurrentRuns: cap, minAvailableMemoryMb: floor, minFreeDiskGb: diskFloor });
        }}
      >
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold">Run limits</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Limit how many agent runs this instance starts at once. Extra runs wait in the queue
            and start when a slot, memory, or disk space frees up. They are never failed or cancelled.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor={capId}>Run cap</Label>
            <Input
              id={capId}
              type="number"
              inputMode="numeric"
              min={RUN_CAP_MIN}
              max={RUN_CAP_MAX}
              step={1}
              value={capInput}
              disabled={disabled}
              aria-invalid={cap === null}
              aria-describedby={`${capId}-help`}
              onChange={(event) => setCapInput(event.target.value)}
            />
            <p id={`${capId}-help`} className="text-xs text-muted-foreground">
              {cap === null
                ? `Enter a whole number from ${RUN_CAP_MIN} to ${RUN_CAP_MAX}.`
                : `Most runs at once, across all agents. Default ${DEFAULT_RUN_ADMISSION_MAX_CONCURRENT_RUNS}.`}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={floorId}>RAM floor (MB)</Label>
            <Input
              id={floorId}
              type="number"
              inputMode="numeric"
              min={0}
              max={RAM_FLOOR_MAX_MB}
              step={256}
              value={floorInput}
              disabled={disabled}
              aria-invalid={floor === null}
              aria-describedby={`${floorId}-help`}
              onChange={(event) => setFloorInput(event.target.value)}
            />
            <p id={`${floorId}-help`} className="text-xs text-muted-foreground">
              {floor === null
                ? `Enter a whole number of MB from 0 to ${RAM_FLOOR_MAX_MB}.`
                : `Hold new runs while free RAM is below this. 0 turns the check off. Default ${DEFAULT_RUN_ADMISSION_MIN_AVAILABLE_MEMORY_MB}.`}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={diskId}>Disk floor (GB)</Label>
            <Input
              id={diskId}
              type="number"
              inputMode="numeric"
              min={0}
              max={DISK_FLOOR_MAX_GB}
              step={1}
              value={diskInput}
              disabled={disabled}
              aria-invalid={diskFloor === null}
              aria-describedby={`${diskId}-help`}
              onChange={(event) => setDiskInput(event.target.value)}
            />
            <p id={`${diskId}-help`} className="text-xs text-muted-foreground">
              {diskFloor === null
                ? `Enter a whole number of GB from 0 to ${DISK_FLOOR_MAX_GB}.`
                : `Hold new runs while free disk for data and worktrees is below this. Running runs keep going. 0 turns the check off. Default ${DEFAULT_RUN_ADMISSION_MIN_FREE_DISK_GB}.`}
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-border px-3 py-2 text-sm" data-testid="run-cap-suggestion">
          {memoryQuery.isLoading ? (
            <span className="text-muted-foreground">Reading machine memory...</span>
          ) : memory ? (
            <div className="space-y-1">
              <div className="text-muted-foreground">
                Total RAM <span className="font-medium text-foreground">{formatGb(memory.totalBytes)}</span>
                {" · "}Available now{" "}
                <span className="font-medium text-foreground">
                  {memory.availableBytes === null ? "unknown" : formatGb(memory.availableBytes)}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span>{describeRunCapSuggestion(memory.totalBytes, suggestionFloor)}</span>
                {suggestedCap !== null && cap !== suggestedCap ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() => setCapInput(String(suggestedCap))}
                  >
                    Use suggested
                  </Button>
                ) : null}
              </div>
              {memory.availableBytes !== null ? (
                <div className="text-xs text-muted-foreground">
                  Free RAM right now can hold about {runsFreeRamCanHold(memory.availableBytes, suggestionFloor)} more
                  runs above the floor.
                </div>
              ) : null}
            </div>
          ) : (
            <span className="text-muted-foreground">
              Machine memory is not available, so no cap is suggested.
            </span>
          )}
        </div>

        {recommendation && hasUsage ? (
          <UsageRecommendation
            recommendation={recommendation}
            savedCap={savedCap}
            savedFloor={savedFloor}
            disabled={disabled}
            onApply={(next) => {
              setCapInput(String(next.maxConcurrentRuns));
              setFloorInput(String(next.minAvailableMemoryMb));
              // The recommendation covers cap and RAM only; keep the saved disk floor.
              onSave({ ...next, minFreeDiskGb: savedDiskFloor });
            }}
          />
        ) : null}

        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={!canSave}>
            Save run limits
          </Button>
          {dirty ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setCapInput(String(savedCap));
                setFloorInput(String(savedFloor));
                setDiskInput(String(savedDiskFloor));
              }}
            >
              Reset
            </Button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function UsageRecommendation({
  recommendation,
  savedCap,
  savedFloor,
  disabled,
  onApply,
}: {
  recommendation: RunAdmissionRecommendation;
  savedCap: number;
  savedFloor: number;
  disabled: boolean;
  onApply: (next: Omit<Required<RunAdmission>, "minFreeDiskGb">) => void;
}) {
  const { suggested } = recommendation;
  const matchesSaved =
    suggested.maxConcurrentRuns === savedCap && suggested.minAvailableMemoryMb === savedFloor;
  const rows = [
    { label: "Run cap", current: String(savedCap), suggested: String(suggested.maxConcurrentRuns) },
    {
      label: "RAM floor",
      current: `${savedFloor} MB`,
      suggested: `${suggested.minAvailableMemoryMb} MB`,
    },
  ];

  return (
    <div
      className="space-y-3 rounded-lg border border-border bg-muted/30 px-3 py-3 text-sm"
      data-testid="run-admission-recommendation"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium">Recommended from your usage</h3>
          <p className="text-xs text-muted-foreground">
            Based on the last {recommendation.windowDays} days. Nothing changes until you apply it.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || matchesSaved}
          onClick={() =>
            onApply({
              maxConcurrentRuns: suggested.maxConcurrentRuns,
              minAvailableMemoryMb: suggested.minAvailableMemoryMb,
            })
          }
        >
          {matchesSaved ? "Applied" : "Apply"}
        </Button>
      </div>
      <table className="w-full max-w-sm text-left">
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 font-normal">Setting</th>
            <th scope="col" className="py-1 font-normal">Current</th>
            <th scope="col" className="py-1 font-normal">Suggested</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row" className="py-1 font-normal text-muted-foreground">{row.label}</th>
              <td className="py-1">{row.current}</td>
              <td className="py-1 font-medium">{row.suggested}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {recommendation.reasons.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {recommendation.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

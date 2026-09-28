import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DEFAULT_RUN_ADMISSION_MAX_CONCURRENT_RUNS,
  DEFAULT_RUN_ADMISSION_MIN_AVAILABLE_MEMORY_MB,
  type InstanceGeneralSettings,
} from "@greatstone/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
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
  const savedCap = runAdmission?.maxConcurrentRuns ?? DEFAULT_RUN_ADMISSION_MAX_CONCURRENT_RUNS;
  const savedFloor = runAdmission?.minAvailableMemoryMb ?? DEFAULT_RUN_ADMISSION_MIN_AVAILABLE_MEMORY_MB;
  const [capInput, setCapInput] = useState(String(savedCap));
  const [floorInput, setFloorInput] = useState(String(savedFloor));

  // Follow the saved values after a save or refetch.
  useEffect(() => setCapInput(String(savedCap)), [savedCap]);
  useEffect(() => setFloorInput(String(savedFloor)), [savedFloor]);

  const memoryQuery = useQuery({
    queryKey: queryKeys.instance.systemMemory,
    queryFn: () => instanceSettingsApi.getSystemMemory(),
    retry: false,
  });

  const cap = parseWholeNumber(capInput, RUN_CAP_MIN, RUN_CAP_MAX);
  const floor = parseWholeNumber(floorInput, 0, RAM_FLOOR_MAX_MB);
  const dirty = cap !== savedCap || floor !== savedFloor;
  const canSave = !disabled && dirty && cap !== null && floor !== null;
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
          if (!canSave || cap === null || floor === null) return;
          // Send both fields: the server replaces the whole runAdmission object.
          onSave({ maxConcurrentRuns: cap, minAvailableMemoryMb: floor });
        }}
      >
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold">Run limits</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Limit how many agent runs this instance starts at once. Extra runs wait in the queue
            and start when a slot or memory frees up. They are never failed or cancelled.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
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

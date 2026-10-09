import { useEffect, useMemo, useState } from "react";
import {
  resolvePipelineAccess,
  type PipelineAccess,
  type PipelineAccessLevel,
  type PrincipalPermissionGrant,
} from "@greatstone/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect } from "@/components/ui/native-select";

const LEVEL_OPTIONS: Array<{ value: PipelineAccessLevel; label: string; hint: string }> = [
  { value: "view", label: "View", hint: "Sees boards, cases, contacts and history. Cannot change them." },
  { value: "work_cases", label: "Work cases", hint: "Creates and edits cases and contacts, moves, claims and suggests." },
  { value: "administer", label: "Administer", hint: "Also creates, renames and archives pipelines and edits stages and moves." },
];

function sameAccess(a: PipelineAccess, b: PipelineAccess) {
  if (a.level !== b.level) return false;
  if (a.level === "view") return true;
  const left = [...(a.pipelineIds ?? [])].sort().join(",");
  const right = [...(b.pipelineIds ?? [])].sort().join(",");
  return (a.pipelineIds === null) === (b.pipelineIds === null) && left === right;
}

/**
 * Pipeline access for one agent (GRE-1072): a level and a scope (all
 * pipelines or a picked list). Saving sends `pipelineAccess` on the agent
 * permissions update; only board users who can manage permissions may save.
 */
export function AgentPipelineAccessControl({
  grants,
  pipelines,
  pipelinesLoading = false,
  disabled = false,
  onSave,
}: {
  grants: Pick<PrincipalPermissionGrant, "permissionKey" | "scope">[];
  pipelines: Array<{ id: string; name: string }>;
  pipelinesLoading?: boolean;
  disabled?: boolean;
  onSave: (access: PipelineAccess) => void;
}) {
  const current = resolvePipelineAccess(grants);
  // Reset the draft only when the saved access really changes, not on every
  // new grants array from a refetch.
  const currentKey = JSON.stringify(current);
  const savedAccess = useMemo(() => JSON.parse(currentKey) as PipelineAccess, [currentKey]);
  const [draft, setDraft] = useState<PipelineAccess>(savedAccess);

  useEffect(() => {
    setDraft(savedAccess);
  }, [savedAccess]);

  const scopeMode = draft.pipelineIds === null ? "all" : "picked";
  const pickedIds = new Set(draft.pipelineIds ?? []);
  const dirty = !sameAccess(draft, savedAccess);
  const pickedEmpty = draft.level !== "view" && draft.pipelineIds !== null && draft.pipelineIds.length === 0;
  const levelHint = LEVEL_OPTIONS.find((option) => option.value === draft.level)?.hint;

  function togglePipeline(id: string, checked: boolean) {
    const next = new Set(pickedIds);
    if (checked) next.add(id);
    else next.delete(id);
    setDraft({ ...draft, pipelineIds: [...next] });
  }

  return (
    <div data-testid="agent-pipeline-access">
      <h3 className="text-sm font-medium mb-1">Pipeline access</h3>
      <p className="text-xs text-muted-foreground mb-3">
        What this agent may do on client pipelines.
      </p>
      <div className="border border-border rounded-lg p-4 space-y-4 text-sm">
        <label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <span>Level</span>
          <NativeSelect
            aria-label="Pipeline access level"
            className="sm:w-48"
            value={draft.level}
            disabled={disabled}
            onChange={(event) => {
              const level = event.target.value as PipelineAccessLevel;
              setDraft({ level, pipelineIds: level === "view" ? null : draft.pipelineIds });
            }}
          >
            {LEVEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </NativeSelect>
        </label>
        {levelHint ? <p className="text-xs text-muted-foreground -mt-2">{levelHint}</p> : null}

        {draft.level !== "view" ? (
          <fieldset className="space-y-2" disabled={disabled}>
            <legend className="mb-1">Pipelines</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="pipeline-access-scope"
                checked={scopeMode === "all"}
                onChange={() => setDraft({ ...draft, pipelineIds: null })}
              />
              All pipelines
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="pipeline-access-scope"
                checked={scopeMode === "picked"}
                onChange={() => setDraft({ ...draft, pipelineIds: draft.pipelineIds ?? [] })}
              />
              Picked pipelines
            </label>
            {scopeMode === "picked" ? (
              <div className="ml-6 space-y-2" aria-label="Picked pipelines">
                {pipelinesLoading ? (
                  <p className="text-xs text-muted-foreground">Loading pipelines…</p>
                ) : pipelines.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No pipelines yet. Choose all pipelines instead.</p>
                ) : (
                  pipelines.map((pipeline) => (
                    <label key={pipeline.id} className="flex items-center gap-2">
                      <Checkbox
                        checked={pickedIds.has(pipeline.id)}
                        onCheckedChange={(checked) => togglePipeline(pipeline.id, checked === true)}
                        aria-label={pipeline.name}
                      />
                      {pipeline.name}
                    </label>
                  ))
                )}
                {pickedEmpty ? <p className="text-xs text-destructive">Pick at least one pipeline.</p> : null}
              </div>
            ) : null}
          </fieldset>
        ) : null}

        {dirty ? (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setDraft(savedAccess)}>
              Cancel
            </Button>
            <Button size="sm" disabled={disabled || pickedEmpty} onClick={() => onSave(draft)}>
              Save pipeline access
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

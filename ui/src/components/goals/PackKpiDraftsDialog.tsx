import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { suggestKpiDraftsFromPack, type Goal, type Issue } from "@greatstone/shared";
import { goalsApi } from "../../api/goals";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import {
  buildKpiDraftRequestRows,
  toEditableRow,
  type EditableKpiDraftRow,
} from "../../lib/kpi-drafts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

/**
 * Pre-fill draft KPIs under a goal from slide 5 of a research pack (GRE-1161).
 * The person names the pack's synthesis task, picks rows and checks each
 * baseline. Peer figures stay in the benchmark note; the target stays empty.
 */
export function PackKpiDraftsDialog({
  goal,
  open,
  onOpenChange,
}: {
  goal: Pick<Goal, "id" | "companyId" | "title">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [issueRef, setIssueRef] = useState("");
  const [documentKey, setDocumentKey] = useState("pre-read");
  const [packIssue, setPackIssue] = useState<Issue | null>(null);
  const [rows, setRows] = useState<EditableKpiDraftRow[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  function reset() {
    setPackIssue(null);
    setRows(null);
    setProblem(null);
  }

  const load = useMutation({
    mutationFn: async () => {
      const issue = await issuesApi.get(issueRef.trim());
      const view = await issuesApi.getDocumentEvidence(issue.id, documentKey.trim());
      return { issue, suggestions: suggestKpiDraftsFromPack(view.bullets) };
    },
    onMutate: reset,
    onSuccess: ({ issue, suggestions }) => {
      setPackIssue(issue);
      setRows(suggestions.map(toEditableRow));
    },
    onError: (error) => setProblem(errorText(error)),
  });

  const create = useMutation({
    mutationFn: (payload: Parameters<typeof goalsApi.createKpiDrafts>[1]) => goalsApi.createKpiDrafts(goal.id, payload),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.goals.detail(goal.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(goal.companyId) }),
      ]);
      reset();
      setIssueRef("");
      onOpenChange(false);
    },
    onError: (error) => setProblem(errorText(error)),
  });

  function update(bulletId: string, patch: Partial<EditableKpiDraftRow>) {
    setRows((current) => current?.map((row) => (row.bulletId === bulletId ? { ...row, ...patch } : row)) ?? null);
  }

  function submitLoad(event: FormEvent) {
    event.preventDefault();
    if (issueRef.trim()) load.mutate();
  }

  function submitCreate() {
    if (!packIssue || !rows) return;
    const built = buildKpiDraftRequestRows(rows);
    setProblem(built.problem);
    if (built.problem) return;
    create.mutate({ sourceIssueId: packIssue.id, documentKey: documentKey.trim(), rows: built.rows });
  }

  const selectedCount = rows?.filter((row) => row.selected).length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="pack-kpi-drafts-dialog">
        <DialogHeader>
          <DialogTitle>Pre-fill KPIs from a research pack</DialogTitle>
          <DialogDescription>
            Pick slide 5 reference points to add as draft KPIs under “{goal.title}”. Peer figures stay as a
            benchmark note, not a target. Drafts have no status until you set a target and accept them.
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end" onSubmit={submitLoad}>
          <div className="space-y-1.5">
            <Label htmlFor="pack-issue">Synthesis task</Label>
            <Input
              id="pack-issue"
              placeholder="e.g. GRE-1201"
              value={issueRef}
              onChange={(event) => setIssueRef(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pack-document">Document</Label>
            <Input id="pack-document" value={documentKey} onChange={(event) => setDocumentKey(event.target.value)} />
          </div>
          <Button type="submit" variant="outline" disabled={!issueRef.trim() || load.isPending}>
            {load.isPending ? "Loading…" : "Load slide 5"}
          </Button>
        </form>

        {rows && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No slide 5 rows in this document. Rows start with a bold ID (e.g. **B1**) under a “Slide 5” heading.
          </p>
        ) : null}

        {rows && rows.length > 0 ? (
          <ul className="space-y-3" aria-label="Slide 5 rows">
            {rows.map((row) => (
              <li key={row.bulletId} className="rounded-lg border border-border bg-card p-3" data-testid={`pack-row-${row.bulletId}`}>
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={row.selected}
                    onCheckedChange={(checked) => update(row.bulletId, { selected: checked === true })}
                    aria-label={`Use ${row.bulletId}`}
                  />
                  <span>
                    <span className="font-semibold">{row.bulletId}</span> {row.text}
                    {row.unsourced ? <span className="ml-1 text-xs text-muted-foreground">(no source linked)</span> : null}
                  </span>
                </label>
                {row.selected ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor={`title-${row.bulletId}`}>KPI name</Label>
                      <Input id={`title-${row.bulletId}`} value={row.title} onChange={(e) => update(row.bulletId, { title: e.target.value })} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`baseline-${row.bulletId}`}>Client baseline</Label>
                      <Input
                        id={`baseline-${row.bulletId}`}
                        inputMode="decimal"
                        value={row.baselineValue}
                        onChange={(e) => update(row.bulletId, { baselineValue: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`unit-${row.bulletId}`}>Unit</Label>
                      <Input id={`unit-${row.bulletId}`} value={row.unit} onChange={(e) => update(row.bulletId, { unit: e.target.value })} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`date-${row.bulletId}`}>Baseline date</Label>
                      <Input
                        id={`date-${row.bulletId}`}
                        type="date"
                        value={row.baselineDate}
                        onChange={(e) => update(row.bulletId, { baselineDate: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`direction-${row.bulletId}`}>Good is</Label>
                      <NativeSelect
                        id={`direction-${row.bulletId}`}
                        value={row.kpiDirection}
                        onChange={(e) => update(row.bulletId, { kpiDirection: e.target.value === "down" ? "down" : "up" })}
                      >
                        <option value="up">Higher</option>
                        <option value="down">Lower</option>
                      </NativeSelect>
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor={`benchmark-${row.bulletId}`}>Benchmark note</Label>
                      <Textarea
                        id={`benchmark-${row.bulletId}`}
                        rows={3}
                        value={row.benchmarkNote}
                        onChange={(e) => update(row.bulletId, { benchmarkNote: e.target.value })}
                      />
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {problem ? (
          <p className="text-sm text-destructive" role="alert">
            {problem}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submitCreate} disabled={!rows || selectedCount === 0 || create.isPending}>
            {create.isPending
              ? "Creating…"
              : selectedCount === 0
                ? "Create draft KPIs"
                : `Create ${selectedCount} draft KPI${selectedCount === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

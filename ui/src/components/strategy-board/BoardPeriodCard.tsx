import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { strategyBoardApi } from "@/api/strategyBoard";
import { useToastActions } from "@/context/ToastContext";
import { boardPeriodError } from "@/lib/strategy-board";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

const PERIOD_LENGTHS = [1, 3, 6, 12] as const;

/**
 * Board period (GRE-3472), for company owners: when the period starts and
 * ends, and how long the next one is. At the end each KPI owner gets one
 * reading-due task; the chair gets one "KPIs off course" task per period.
 */
export function BoardPeriodCard({ companyId, today }: { companyId: string; today: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const settings = useQuery({
    queryKey: queryKeys.strategyBoard.settings(companyId),
    queryFn: () => strategyBoardApi.settings(companyId),
  });
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [months, setMonths] = useState("");
  useEffect(() => {
    if (!settings.data) return;
    setStart(settings.data.periodStart ?? "");
    setEnd(settings.data.periodEnd ?? "");
    setMonths(settings.data.periodMonths ? String(settings.data.periodMonths) : "");
  }, [settings.data]);
  const save = useMutation({
    mutationFn: () =>
      strategyBoardApi.updateSettings(companyId, {
        periodStart: start || null,
        periodEnd: end || null,
        periodMonths: months ? Number(months) : null,
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.strategyBoard.settings(companyId), next);
      // The board header shows the period.
      void queryClient.invalidateQueries({ queryKey: queryKeys.strategyBoard.summary(companyId), exact: true });
      pushToast({ title: "Board period saved", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: "Board period not saved", body: err.message, tone: "error" }),
  });

  if (settings.isLoading) return <p className="text-sm text-muted-foreground">Loading board period…</p>;
  if (settings.error) return <p className="text-sm text-status-danger">Could not load board period: {(settings.error as Error).message}</p>;
  const error = boardPeriodError(start, end);
  const savedEnd = settings.data?.periodEnd ?? null;
  const ended = savedEnd != null && today > savedEnd && !settings.data?.periodMonths;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        When the period ends, each KPI owner gets one task listing their KPIs with no reading in the period. The chair
        gets one task per period that lists every KPI off course. A new board pack covers this period.
      </p>
      {ended ? <p className="text-sm font-medium text-status-warning">This period has ended. Set the next period.</p> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="board-period-start">Period starts</Label>
          <Input id="board-period-start" type="date" value={start} onChange={(event) => setStart(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="board-period-end">Period ends</Label>
          <Input id="board-period-end" type="date" value={end} onChange={(event) => setEnd(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="board-period-months">Next period</Label>
          <NativeSelect id="board-period-months" value={months} onChange={(event) => setMonths(event.target.value)}>
            <option value="">I set it by hand</option>
            {PERIOD_LENGTHS.map((length) => (
              <option key={length} value={String(length)}>
                Starts by itself, {length === 1 ? "1 month" : `${length} months`}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {error ? <p className="text-sm text-status-danger">{error}</p> : null}
      <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || error != null}>
        {save.isPending ? "Saving…" : "Save board period"}
      </Button>
    </div>
  );
}

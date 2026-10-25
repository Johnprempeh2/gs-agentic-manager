import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Workflow, X } from "lucide-react";
import {
  DEEP_DIVE_CANVAS,
  DEEP_DIVE_LABELS,
  DEEP_DIVE_VISIBILITIES,
  deepDiveAutoLayout,
  deepDiveProcessArrows,
  deepDiveProcessLanes,
  type DeepDiveProcess,
  type DeepDiveProcessBoard as ProcessBoard,
  type DeepDiveVisibility,
} from "@greatstone/shared";
import { deepDiveBoardsQueryKeys, deepDiveProcessApi } from "@/api/deepDiveBoards";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";

// Deep Dive process board (GRE-2369): Screen 6 of the GRE-2327 plan, from the
// website portal's process canvas. One lane per offering; cards can be dragged
// to arrange them and the position is saved on drop. Where a card sits is
// layout, never a claim: an arrow is drawn only for a recorded handoff, and the
// only way to draw one is to record the handoff and name what is handed over.

const { cardWidth: W, cardHeight: H, pad: PAD, grid: GRID } = DEEP_DIVE_CANVAS;
const LANE_LABEL = 28;
const MIN_WIDTH = 640;

type Point = { x: number; y: number };
type Run = (write: () => Promise<ProcessBoard>) => void;

function errorText(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

function VisibilitySelect({ value, label, onChange }: { value: DeepDiveVisibility; label: string; onChange: (value: DeepDiveVisibility) => void }) {
  return (
    <NativeSelect aria-label={label} className="h-8 w-auto text-xs" value={value} onChange={(event) => onChange(event.target.value as DeepDiveVisibility)}>
      {DEEP_DIVE_VISIBILITIES.map((option) => (
        <option key={option} value={option}>{DEEP_DIVE_LABELS[option]}</option>
      ))}
    </NativeSelect>
  );
}

/**
 * A cubic from the right edge of one card to the left edge of the other; when
 * the target is not to the right, from the bottom (or top) edge to the other's
 * top (or bottom), so the curve never runs off the canvas.
 */
function arrowPath(a: Point, b: Point): string {
  if (b.x >= a.x + W + 20) {
    const x1 = a.x + W;
    const y1 = a.y + H / 2;
    const x2 = b.x;
    const y2 = b.y + H / 2;
    const bend = (x2 - x1) / 2;
    return `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
  }
  const down = b.y >= a.y;
  const x1 = a.x + W / 2;
  const y1 = down ? a.y + H : a.y;
  const x2 = b.x + W / 2;
  const y2 = down ? b.y : b.y + H;
  const bend = Math.max(30, Math.abs(y2 - y1) / 2) * (down ? 1 : -1);
  return `M${x1} ${y1} C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`;
}

interface Drag {
  processId: string;
  laneTop: number;
  grab: Point;
  at: Point;
  moved: boolean;
}

/**
 * The canvas: lanes stacked top to bottom, cards placed in their lane, and one
 * SVG underneath with an arrow for each recorded handoff.
 */
export function ProcessCanvas({ board, onMove }: { board: ProcessBoard; onMove: (processId: string, at: Point) => void }) {
  const canvas = useRef<HTMLDivElement>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  // The drop reads the ref, so a quick release never sees a stale drag.
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (next: Drag | null) => {
    dragRef.current = next;
    setDragState(next);
  };
  const names = useMemo(() => new Map(board.people.map((person) => [person.id, person.name])), [board.people]);
  const units = useMemo(() => new Map(board.units.map((unit) => [unit.id, unit.name])), [board.units]);

  const lanes = useMemo(() => {
    let top = 0;
    return deepDiveProcessLanes(board).map((lane) => {
      const auto = deepDiveAutoLayout(lane.processes, board.handoffs);
      const local = new Map<string, Point>(
        lane.processes.map((process) => [
          process.id,
          process.x !== null && process.y !== null ? { x: process.x, y: process.y } : (auto.get(process.id) ?? { x: PAD, y: PAD }),
        ]),
      );
      const height = Math.max(H + 2 * PAD, ...[...local.values()].map((point) => point.y + H + PAD));
      const placed = { ...lane, local, top, height };
      top += LANE_LABEL + height;
      return placed;
    });
  }, [board]);

  // Where each card is drawn, in canvas pixels; the card being dragged follows the pointer.
  const positions = new Map<string, Point>();
  for (const lane of lanes) {
    for (const [id, point] of lane.local) {
      const at = drag?.processId === id ? drag.at : point;
      positions.set(id, { x: at.x, y: lane.top + LANE_LABEL + at.y });
    }
  }
  const width = Math.max(MIN_WIDTH, ...[...positions.values()].map((point) => point.x + W + PAD));
  const dragLaneBottom = drag ? drag.laneTop + LANE_LABEL + drag.at.y + H + PAD : 0;
  const height = Math.max(lanes.reduce((n, lane) => n + LANE_LABEL + lane.height, 0), dragLaneBottom);
  const arrows = deepDiveProcessArrows(board);

  function pointer(event: PointerEvent): Point {
    const rect = canvas.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function startDrag(event: PointerEvent<HTMLDivElement>, process: DeepDiveProcess, laneTop: number) {
    if (event.button !== 0) return;
    const at = positions.get(process.id)!;
    const local = { x: at.x, y: at.y - laneTop - LANE_LABEL };
    const p = pointer(event);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ processId: process.id, laneTop, grab: { x: p.x - at.x, y: p.y - at.y }, at: local, moved: false });
  }

  function moveDrag(event: PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const p = pointer(event);
    const snap = (value: number) => Math.max(0, Math.round(value / GRID) * GRID);
    setDrag({ ...drag, at: { x: snap(p.x - drag.grab.x), y: snap(p.y - drag.grab.y - drag.laneTop - LANE_LABEL) }, moved: true });
  }

  function endDrag() {
    const drag = dragRef.current;
    if (!drag) return;
    // One write, on drop.
    if (drag.moved) onMove(drag.processId, drag.at);
    setDrag(null);
  }

  return (
    <div className="overflow-auto rounded-lg border border-border bg-muted/30" data-testid="process-canvas">
      <div ref={canvas} className="relative" style={{ width, height }} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
        {lanes.map((lane) => (
          <section
            key={lane.offering?.id ?? "unnamed"}
            aria-label={lane.offering ? `Lane ${lane.offering.name}` : "Lane: no offering named"}
            className="absolute inset-x-0 border-b border-border last:border-b-0"
            style={{ top: lane.top, height: LANE_LABEL + lane.height }}
          >
            <h3 className="sticky left-0 inline-block px-3 pt-1.5 text-xs font-semibold text-muted-foreground">
              {lane.offering ? lane.offering.name : "No offering named"}
              {lane.processes.length === 0 ? " · no processes yet" : ""}
            </h3>
          </section>
        ))}
        <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden={arrows.length === 0}>
          <defs>
            <marker id="deep-dive-arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" className="fill-foreground/60" />
            </marker>
          </defs>
          {arrows.map((arrow) => {
            const a = positions.get(arrow.fromProcessId);
            const b = positions.get(arrow.toProcessId);
            if (!a || !b) return null;
            return (
              <path
                key={arrow.handoffId}
                data-handoff-id={arrow.handoffId}
                d={arrowPath(a, b)}
                className="fill-none stroke-foreground/60"
                strokeWidth={1.5}
                markerEnd="url(#deep-dive-arrowhead)"
              >
                <title>{arrow.what}</title>
              </path>
            );
          })}
        </svg>
        {lanes.flatMap((lane) =>
          lane.processes.map((process) => {
            const at = positions.get(process.id)!;
            const runs = process.runsPersonId ? names.get(process.runsPersonId) : null;
            const unit = process.unitId ? units.get(process.unitId) : null;
            return (
              <div
                key={process.id}
                data-process-id={process.id}
                role="group"
                aria-label={`Process ${process.name}`}
                onPointerDown={(event) => startDrag(event, process, lane.top)}
                className={cn(
                  "absolute flex cursor-grab touch-none select-none flex-col gap-1 overflow-hidden rounded-lg border border-border bg-card px-3 py-2 shadow-xs",
                  drag?.processId === process.id && "cursor-grabbing ring-2 ring-ring/50",
                )}
                style={{ left: at.x, top: at.y, width: W, height: H }}
              >
                <p className="line-clamp-2 text-sm font-medium leading-snug">{process.name}</p>
                <p className="truncate text-xs text-muted-foreground">Runs it: {runs ?? "not recorded"}</p>
                {unit ? <p className="truncate text-xs text-muted-foreground">{unit}</p> : null}
              </div>
            );
          }),
        )}
      </div>
    </div>
  );
}

function HandoffForm({ board, run, companyId }: { board: ProcessBoard; run: Run; companyId: string }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [what, setWhat] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!from || !to) return setError("Choose the process the work starts in and the one it is handed to.");
    if (from === to) return setError("A process cannot hand off to itself.");
    if (!what.trim()) return setError("Name what is handed over. A handoff with nothing named is not recorded.");
    setError(null);
    run(() => deepDiveProcessApi.recordHandoff(companyId, { fromProcessId: from, toProcessId: to, what: what.trim() }));
    setWhat("");
  }

  return (
    <form onSubmit={submit} className="space-y-2" aria-labelledby="deep-dive-record-handoff">
      <h2 id="deep-dive-record-handoff" className="text-sm font-semibold">Record a handoff</h2>
      <p className="text-xs text-muted-foreground">This is the only way an arrow appears on the board.</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <NativeSelect aria-label="Hands off from" value={from} onChange={(event) => setFrom(event.target.value)}>
          <option value="">From…</option>
          {board.processes.map((process) => <option key={process.id} value={process.id}>{process.name}</option>)}
        </NativeSelect>
        <NativeSelect aria-label="Hands off to" value={to} onChange={(event) => setTo(event.target.value)}>
          <option value="">To…</option>
          {board.processes.map((process) => <option key={process.id} value={process.id}>{process.name}</option>)}
        </NativeSelect>
        <Input aria-label="What is handed over" placeholder="What is handed over" value={what} onChange={(event) => setWhat(event.target.value)} />
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <Button type="submit" size="sm" disabled={board.processes.length < 2}>Record handoff</Button>
    </form>
  );
}

export function DeepDiveProcessBoard() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const [offeringName, setOfferingName] = useState("");
  const [processName, setProcessName] = useState("");
  const [processLane, setProcessLane] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Deep Dive", href: "/deep-dive" }, { label: "Process board" }]);
  }, [setBreadcrumbs]);

  const queryKey = deepDiveBoardsQueryKeys.process(companyId);
  const boardQuery = useQuery({ queryKey, queryFn: () => deepDiveProcessApi.get(companyId), enabled: !!selectedCompanyId });
  const writeMutation = useMutation({
    mutationFn: (write: () => Promise<ProcessBoard>) => write(),
    onSuccess: (board) => queryClient.setQueryData(queryKey, board),
  });
  const run: Run = (write) => writeMutation.mutate(write);

  if (!selectedCompanyId) return <EmptyState icon={Workflow} message="Select a company to see its process board." />;
  if (boardQuery.isLoading) return <PageSkeleton variant="list" />;
  if (boardQuery.error || !boardQuery.data) return <p className="text-sm text-destructive">{errorText(boardQuery.error) ?? "The board did not load."}</p>;

  const board = boardQuery.data;
  const placed = board.processes.filter((process) => process.x !== null);
  const nameOf = (id: string) => board.processes.find((process) => process.id === id)?.name ?? "a removed process";

  function moveCard(processId: string, at: Point) {
    // Show the card where it was dropped while the position saves.
    queryClient.setQueryData<ProcessBoard>(queryKey, (current) =>
      current && { ...current, processes: current.processes.map((process) => (process.id === processId ? { ...process, ...at } : process)) },
    );
    run(() => deepDiveProcessApi.saveLayout(companyId, { positions: [{ processId, ...at }] }));
  }

  function addOffering(event: FormEvent) {
    event.preventDefault();
    if (!offeringName.trim()) return;
    run(() => deepDiveProcessApi.addOffering(companyId, { name: offeringName.trim() }));
    setOfferingName("");
  }

  function addProcess(event: FormEvent) {
    event.preventDefault();
    if (!processName.trim()) return;
    run(() => deepDiveProcessApi.addProcess(companyId, { name: processName.trim(), offeringId: processLane || null }));
    setProcessName("");
  }

  const writeError = errorText(writeMutation.error);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-bold">Process board</h1>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <Link to="/deep-dive/organisation" className="text-xs font-medium underline-offset-4 hover:underline">Organisation board</Link>
            <Link to="/deep-dive" className="text-xs font-medium underline-offset-4 hover:underline">Back to the Deep Dive</Link>
          </div>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          One lane per offering. Drag a card to arrange it; where it sits is layout, not order. An arrow appears only
          where a handoff is recorded. Everything starts Internal.
        </p>
      </header>

      {writeError ? <p role="alert" className="text-sm text-destructive">{writeError}</p> : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="gap-2 px-4 py-3">
          <form onSubmit={addOffering} className="space-y-2" aria-labelledby="deep-dive-add-offering">
            <h2 id="deep-dive-add-offering" className="text-sm font-semibold">Add an offering</h2>
            <div className="flex gap-2">
              <Input aria-label="Offering name" placeholder="What the business sells" value={offeringName} onChange={(event) => setOfferingName(event.target.value)} />
              <Button type="submit" size="sm" disabled={!offeringName.trim()}>Add</Button>
            </div>
          </form>
        </Card>
        <Card className="gap-2 px-4 py-3">
          <form onSubmit={addProcess} className="space-y-2" aria-labelledby="deep-dive-add-process">
            <h2 id="deep-dive-add-process" className="text-sm font-semibold">Add a process</h2>
            <div className="grid gap-2 sm:grid-cols-[1fr_12rem_auto]">
              <Input aria-label="Process name" placeholder="Process name" value={processName} onChange={(event) => setProcessName(event.target.value)} />
              <NativeSelect aria-label="Lane for the new process" value={processLane} onChange={(event) => setProcessLane(event.target.value)}>
                <option value="">No offering named</option>
                {board.offerings.map((offering) => <option key={offering.id} value={offering.id}>{offering.name}</option>)}
              </NativeSelect>
              <Button type="submit" size="sm" disabled={!processName.trim()}>Add</Button>
            </div>
          </form>
        </Card>
      </div>

      {board.processes.length === 0 && board.offerings.length === 0 ? (
        <EmptyState icon={Workflow} message="No offerings or processes yet. Add an offering, then the processes that deliver it." />
      ) : (
        <section aria-labelledby="deep-dive-canvas" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="deep-dive-canvas" className="text-sm font-semibold">
              Canvas · {board.processes.length} processes · {board.handoffs.length} handoffs recorded
            </h2>
            {placed.length > 0 ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => run(() => deepDiveProcessApi.saveLayout(companyId, { positions: placed.map((process) => ({ processId: process.id, x: null, y: null })) }))}
              >
                Tidy up
              </Button>
            ) : null}
          </div>
          <ProcessCanvas board={board} onMove={moveCard} />
        </section>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="gap-2 px-4 py-3">
          <HandoffForm board={board} run={run} companyId={companyId} />
          {board.handoffs.length > 0 ? (
            <ul className="space-y-1.5" aria-label="Recorded handoffs">
              {board.handoffs.map((handoff) => (
                <li key={handoff.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span>
                    <span className="font-medium">{nameOf(handoff.fromProcessId)}</span> → <span className="font-medium">{nameOf(handoff.toProcessId)}</span>
                    <span className="text-muted-foreground">: {handoff.what}</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <VisibilitySelect value={handoff.visibility} label={`Sharing for handoff ${handoff.what}`} onChange={(visibility) => run(() => deepDiveProcessApi.updateHandoff(handoff.id, { visibility }))} />
                    <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove handoff ${handoff.what}`} onClick={() => run(() => deepDiveProcessApi.removeHandoff(handoff.id))}>
                      <X />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
        <Card className="gap-2 px-4 py-3">
          <h2 className="text-sm font-semibold">Offerings and processes</h2>
          <ul className="space-y-1.5" aria-label="Offerings">
            {board.offerings.map((offering) => (
              <li key={offering.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium">{offering.name}</span>
                <span className="flex items-center gap-1">
                  <VisibilitySelect value={offering.visibility} label={`Sharing for ${offering.name}`} onChange={(visibility) => run(() => deepDiveProcessApi.updateOffering(offering.id, { visibility }))} />
                  <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove offering ${offering.name}`} onClick={() => run(() => deepDiveProcessApi.removeOffering(offering.id))}>
                    <X />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
          <ul className="space-y-2 border-t border-border pt-2" aria-label="Processes">
            {board.processes.map((process) => (
              <li key={process.id} className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{process.name}</span>
                  <span className="flex items-center gap-1">
                    <VisibilitySelect value={process.visibility} label={`Sharing for ${process.name}`} onChange={(visibility) => run(() => deepDiveProcessApi.updateProcess(process.id, { visibility }))} />
                    <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove process ${process.name}`} onClick={() => run(() => deepDiveProcessApi.removeProcess(process.id))}>
                      <X />
                    </Button>
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <NativeSelect aria-label={`Lane for ${process.name}`} className="h-8 text-xs" value={process.offeringId ?? ""} onChange={(event) => { const value = event.target.value; run(() => deepDiveProcessApi.updateProcess(process.id, { offeringId: value || null })); }}>
                    <option value="">No offering named</option>
                    {board.offerings.map((offering) => <option key={offering.id} value={offering.id}>{offering.name}</option>)}
                  </NativeSelect>
                  <NativeSelect aria-label={`Who runs ${process.name}`} className="h-8 text-xs" value={process.runsPersonId ?? ""} onChange={(event) => { const value = event.target.value; run(() => deepDiveProcessApi.updateProcess(process.id, { runsPersonId: value || null })); }}>
                    <option value="">Runs it: not recorded</option>
                    {board.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                  </NativeSelect>
                  <NativeSelect aria-label={`Unit for ${process.name}`} className="h-8 text-xs" value={process.unitId ?? ""} onChange={(event) => { const value = event.target.value; run(() => deepDiveProcessApi.updateProcess(process.id, { unitId: value || null })); }}>
                    <option value="">Unit: not recorded</option>
                    {board.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                  </NativeSelect>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

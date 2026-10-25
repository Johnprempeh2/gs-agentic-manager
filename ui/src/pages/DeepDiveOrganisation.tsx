import { useEffect, useMemo, useState, type DragEvent, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Network, X } from "lucide-react";
import {
  DEEP_DIVE_LABELS,
  DEEP_DIVE_PERSON_SIDES,
  DEEP_DIVE_TASK_FATES,
  DEEP_DIVE_TASK_FATE_LABELS,
  DEEP_DIVE_TASK_FATE_MEANS,
  DEEP_DIVE_UNIT_TYPES,
  DEEP_DIVE_VISIBILITIES,
  deepDiveOrgTree,
  deepDiveTargetState,
  deepDiveUnplacedPeople,
  type DeepDiveOrgBoard,
  type DeepDivePerson,
  type DeepDivePersonSide,
  type DeepDiveTaskFate,
  type DeepDiveUnitNode,
  type DeepDiveUnitType,
  type DeepDiveVisibility,
} from "@greatstone/shared";
import { deepDiveBoardsQueryKeys, deepDiveOrgApi } from "@/api/deepDiveBoards";
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

// Deep Dive organisation board (GRE-2369): Screen 5 of the GRE-2327 plan, from
// the website portal. Units as a tree, the people in each, the people nobody
// has placed yet, and the target state from each person's tasks. Drag a person
// onto a unit to place them (or use the Unit picker on a phone); every change
// is saved at once and the board reloads as saved.

const UNIT_TYPE_LABELS: Record<DeepDiveUnitType, string> = {
  company: "Company",
  division: "Division",
  department: "Department",
  team: "Team",
};
const SIDE_LABELS: Record<DeepDivePersonSide, string> = { client: "Client", greatstone: "Greatstone", third_party: "Third party" };
const PERSON_DRAG_TYPE = "application/x-deep-dive-person";

function errorText(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

function hours(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

type Run = (write: () => Promise<DeepDiveOrgBoard>) => void;

function VisibilitySelect({ value, label, onChange }: { value: DeepDiveVisibility; label: string; onChange: (value: DeepDiveVisibility) => void }) {
  return (
    <NativeSelect aria-label={label} className="h-8 w-auto text-xs" value={value} onChange={(event) => onChange(event.target.value as DeepDiveVisibility)}>
      {DEEP_DIVE_VISIBILITIES.map((option) => (
        <option key={option} value={option}>{DEEP_DIVE_LABELS[option]}</option>
      ))}
    </NativeSelect>
  );
}

function PersonChip({ person }: { person: DeepDivePerson }) {
  return (
    <li
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(PERSON_DRAG_TYPE, person.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      className="cursor-grab rounded-md border border-border bg-background px-2 py-1 text-xs active:cursor-grabbing"
      title="Drag onto a unit to place this person"
    >
      <span className="font-medium">{person.name}</span>
      {person.role ? <span className="text-muted-foreground"> · {person.role}</span> : null}
    </li>
  );
}

/** A place a person can be dropped: a unit, or Unplaced (unitId null). */
function useDropTarget(unitId: string | null, onPlace: (personId: string, unitId: string | null) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    handlers: {
      onDragOver: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes(PERSON_DRAG_TYPE)) return;
        event.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent) => {
        event.preventDefault();
        setOver(false);
        const personId = event.dataTransfer.getData(PERSON_DRAG_TYPE);
        if (personId) onPlace(personId, unitId);
      },
    },
  };
}

function UnitCard({
  node,
  siblings,
  board,
  run,
  onPlace,
}: {
  node: DeepDiveUnitNode;
  siblings: DeepDiveUnitNode[];
  board: DeepDiveOrgBoard;
  run: Run;
  onPlace: (personId: string, unitId: string | null) => void;
}) {
  const { unit } = node;
  const people = board.people.filter((person) => person.unitId === unit.id);
  const drop = useDropTarget(unit.id, onPlace);
  const index = siblings.findIndex((sibling) => sibling.unit.id === unit.id);
  const [headcount, setHeadcount] = useState(unit.headcount === null ? "" : String(unit.headcount));
  useEffect(() => setHeadcount(unit.headcount === null ? "" : String(unit.headcount)), [unit.headcount]);

  /** Swap with the sibling above or below and save the new order of the siblings. */
  function move(step: -1 | 1) {
    if (!siblings[index + step]) return;
    const order = siblings.map((sibling) => sibling.unit);
    [order[index], order[index + step]] = [order[index + step]!, order[index]!];
    run(async () => {
      let saved: DeepDiveOrgBoard = board;
      for (const [position, entry] of order.entries()) {
        if (entry.position !== position) saved = await deepDiveOrgApi.updateUnit(entry.id, { position });
      }
      return saved;
    });
  }

  function saveHeadcount() {
    const value = headcount.trim() === "" ? null : Number(headcount);
    if (value !== null && (!Number.isInteger(value) || value < 0)) return;
    if (value !== unit.headcount) run(() => deepDiveOrgApi.updateUnit(unit.id, { headcount: value }));
  }

  return (
    <li className="space-y-2">
      <section
        aria-label={`Unit ${unit.name}`}
        {...drop.handlers}
        className={cn("space-y-2 rounded-lg border border-border bg-card px-3 py-2", drop.over && "border-ring ring-2 ring-ring/40")}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{unit.name}</h3>
            <p className="text-xs text-muted-foreground">
              {UNIT_TYPE_LABELS[unit.unitType]} · {people.length} named
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Button type="button" size="icon-xs" variant="ghost" aria-label={`Move ${unit.name} up`} disabled={index <= 0} onClick={() => move(-1)}>
              <ArrowUp />
            </Button>
            <Button type="button" size="icon-xs" variant="ghost" aria-label={`Move ${unit.name} down`} disabled={index >= siblings.length - 1} onClick={() => move(1)}>
              <ArrowDown />
            </Button>
            <VisibilitySelect value={unit.visibility} label={`Sharing for ${unit.name}`} onChange={(visibility) => run(() => deepDiveOrgApi.updateUnit(unit.id, { visibility }))} />
            <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove ${unit.name}`} onClick={() => run(() => deepDiveOrgApi.removeUnit(unit.id))}>
              <X />
            </Button>
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Lead</span>
            <NativeSelect className="h-8 text-xs" value={unit.leadPersonId ?? ""} onChange={(event) => { const value = event.target.value; run(() => deepDiveOrgApi.updateUnit(unit.id, { leadPersonId: value || null })); }}>
              <option value="">Not recorded</option>
              {board.people.map((person) => (
                <option key={person.id} value={person.id}>{person.name}</option>
              ))}
            </NativeSelect>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Headcount</span>
            <Input className="h-8 text-xs" inputMode="numeric" placeholder="Not recorded" value={headcount} onChange={(event) => setHeadcount(event.target.value)} onBlur={saveHeadcount} />
          </label>
        </div>
        {people.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">{people.map((person) => <PersonChip key={person.id} person={person} />)}</ul>
        ) : (
          <p className="text-xs text-muted-foreground">Nobody placed here yet. Drag a person onto this unit.</p>
        )}
      </section>
      {node.children.length > 0 ? (
        <ul className="space-y-2 border-l border-border pl-3 sm:pl-5">
          {node.children.map((child) => (
            <UnitCard key={child.unit.id} node={child} siblings={node.children} board={board} run={run} onPlace={onPlace} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function TargetState({ board }: { board: DeepDiveOrgBoard }) {
  const state = useMemo(() => deepDiveTargetState(board), [board]);
  return (
    <Card className="gap-2 px-4 py-3" aria-labelledby="deep-dive-target-state">
      <h2 id="deep-dive-target-state" className="text-sm font-semibold">Target state</h2>
      <p className="text-2xl font-bold tabular-nums">
        {state.headcountNow} <span aria-hidden="true">→</span><span className="sr-only">to</span> {state.headcountAfter}
        <span className="ml-2 text-sm font-normal text-muted-foreground">people</span>
      </p>
      <ul className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        <li>{hours(state.hoursFreed)} of {hours(state.hoursNow)} recorded hours a week come off people (eliminated, automated, agentic).</li>
        <li>{hours(state.hoursMoved)} hours move to somebody else: the business still does that work.</li>
        <li>{hours(state.hoursLightened)} hours are lighter but stay with the same person.</li>
        <li>
          {state.undecided} of {state.tasks} tasks not decided; {state.hoursUnknown} with no hours recorded.
        </li>
      </ul>
      <p className="text-xs text-muted-foreground">
        Rests on the tasks of {state.restsOn.peopleMapped} of {state.restsOn.ofPeople} client people, at {state.restsOn.hoursPerWeek} hours a
        week, rounded down. Nothing comes from a job title.
      </p>
    </Card>
  );
}

function PersonRow({ person, board, run }: { person: DeepDivePerson; board: DeepDiveOrgBoard; run: Run }) {
  const tasks = board.tasks.filter((task) => task.personId === person.id);
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState("");
  const [taskHours, setTaskHours] = useState("");

  function addTask(event: FormEvent) {
    event.preventDefault();
    if (!what.trim()) return;
    const value = taskHours.trim() === "" ? null : Number(taskHours);
    run(() => deepDiveOrgApi.addTask(person.id, { what: what.trim(), hoursPerWeek: Number.isFinite(value) ? value : null }));
    setWhat("");
    setTaskHours("");
  }

  return (
    <li className="space-y-2 rounded-lg border border-border px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{person.name}</p>
          <p className="text-xs text-muted-foreground">{person.role || "Role not recorded"} · {SIDE_LABELS[person.side]}</p>
        </div>
        <div className="flex items-center gap-1">
          <VisibilitySelect value={person.visibility} label={`Sharing for ${person.name}`} onChange={(visibility) => run(() => deepDiveOrgApi.updatePerson(person.id, { visibility }))} />
          <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove ${person.name}`} onClick={() => run(() => deepDiveOrgApi.removePerson(person.id))}>
            <X />
          </Button>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Unit</span>
          <NativeSelect className="h-8 text-xs" value={person.unitId ?? ""} onChange={(event) => { const value = event.target.value; run(() => deepDiveOrgApi.updatePerson(person.id, { unitId: value || null })); }}>
            <option value="">Unplaced</option>
            {board.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
          </NativeSelect>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Reports to</span>
          <NativeSelect className="h-8 text-xs" value={person.reportsToId ?? ""} onChange={(event) => { const value = event.target.value; run(() => deepDiveOrgApi.updatePerson(person.id, { reportsToId: value || null })); }}>
            <option value="">Not recorded</option>
            {board.people.filter((other) => other.id !== person.id).map((other) => <option key={other.id} value={other.id}>{other.name}</option>)}
          </NativeSelect>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Side</span>
          <NativeSelect className="h-8 text-xs" value={person.side} onChange={(event) => { const value = event.target.value; run(() => deepDiveOrgApi.updatePerson(person.id, { side: value as DeepDivePersonSide })); }}>
            {DEEP_DIVE_PERSON_SIDES.map((side) => <option key={side} value={side}>{SIDE_LABELS[side]}</option>)}
          </NativeSelect>
        </label>
      </div>
      <Button type="button" size="xs" variant="ghost" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "Hide tasks" : `Tasks (${tasks.length})`}
      </Button>
      {open ? (
        <div className="space-y-2">
          {tasks.length > 0 ? (
            <ul className="space-y-1.5">
              {tasks.map((task) => (
                <li key={task.id} className="grid items-center gap-2 text-xs sm:grid-cols-[1fr_6rem_10rem_auto]">
                  <span>{task.what}</span>
                  <span className="text-muted-foreground">{task.hoursPerWeek === null ? "Hours not recorded" : `${hours(task.hoursPerWeek)} h/week`}</span>
                  <NativeSelect
                    aria-label={`Fate of ${task.what}`}
                    title={DEEP_DIVE_TASK_FATE_MEANS[task.fate]}
                    className="h-8 text-xs"
                    value={task.fate}
                    onChange={(event) => { const value = event.target.value; run(() => deepDiveOrgApi.updateTask(task.id, { fate: value as DeepDiveTaskFate })); }}
                  >
                    {DEEP_DIVE_TASK_FATES.map((fate) => <option key={fate} value={fate}>{DEEP_DIVE_TASK_FATE_LABELS[fate]}</option>)}
                  </NativeSelect>
                  <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove task ${task.what}`} onClick={() => run(() => deepDiveOrgApi.removeTask(task.id))}>
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <form onSubmit={addTask} className="grid gap-2 sm:grid-cols-[1fr_7rem_auto]" aria-label={`Add a task for ${person.name}`}>
            <Input className="h-8 text-xs" placeholder="What they do" value={what} onChange={(event) => setWhat(event.target.value)} />
            <Input className="h-8 text-xs" inputMode="decimal" placeholder="Hours a week" value={taskHours} onChange={(event) => setTaskHours(event.target.value)} />
            <Button type="submit" size="sm" disabled={!what.trim()}>Add task</Button>
          </form>
        </div>
      ) : null}
    </li>
  );
}

export function DeepDiveOrganisation() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const [unitName, setUnitName] = useState("");
  const [unitType, setUnitType] = useState<DeepDiveUnitType>("team");
  const [unitParent, setUnitParent] = useState("");
  const [personName, setPersonName] = useState("");
  const [personRole, setPersonRole] = useState("");
  const [personUnit, setPersonUnit] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Deep Dive", href: "/deep-dive" }, { label: "Organisation" }]);
  }, [setBreadcrumbs]);

  const boardQuery = useQuery({
    queryKey: deepDiveBoardsQueryKeys.organisation(companyId),
    queryFn: () => deepDiveOrgApi.get(companyId),
    enabled: !!selectedCompanyId,
  });
  const writeMutation = useMutation({
    mutationFn: (write: () => Promise<DeepDiveOrgBoard>) => write(),
    onSuccess: (board) => queryClient.setQueryData(deepDiveBoardsQueryKeys.organisation(companyId), board),
  });
  const run: Run = (write) => writeMutation.mutate(write);
  const place = (personId: string, unitId: string | null) => {
    const person = boardQuery.data?.people.find((entry) => entry.id === personId);
    if (person && person.unitId !== unitId) run(() => deepDiveOrgApi.updatePerson(personId, { unitId }));
  };
  const unplacedDrop = useDropTarget(null, place);

  if (!selectedCompanyId) return <EmptyState icon={Network} message="Select a company to see its organisation board." />;
  if (boardQuery.isLoading) return <PageSkeleton variant="list" />;
  if (boardQuery.error || !boardQuery.data) return <p className="text-sm text-destructive">{errorText(boardQuery.error) ?? "The board did not load."}</p>;

  const board = boardQuery.data;
  const tree = deepDiveOrgTree(board.units);
  const unplaced = deepDiveUnplacedPeople(board.people, board.units);

  function addUnit(event: FormEvent) {
    event.preventDefault();
    if (!unitName.trim()) return;
    run(() => deepDiveOrgApi.addUnit(companyId, { name: unitName.trim(), unitType, parentId: unitParent || null }));
    setUnitName("");
  }

  function addPerson(event: FormEvent) {
    event.preventDefault();
    if (!personName.trim()) return;
    run(() => deepDiveOrgApi.addPerson(companyId, { name: personName.trim(), role: personRole.trim(), unitId: personUnit || null }));
    setPersonName("");
    setPersonRole("");
  }

  const writeError = errorText(writeMutation.error);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-bold">Organisation board</h1>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <Link to="/deep-dive/processes" className="text-xs font-medium underline-offset-4 hover:underline">Process board</Link>
            <Link to="/deep-dive" className="text-xs font-medium underline-offset-4 hover:underline">Back to the Deep Dive</Link>
          </div>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          The units of the business, who sits in each, and who nobody has placed yet. Drag a person onto a unit to place
          them. The target state comes only from tasks somebody recorded and the fate chosen for each. Everything starts
          Internal.
        </p>
      </header>

      {writeError ? <p role="alert" className="text-sm text-destructive">{writeError}</p> : null}

      <TargetState board={board} />

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="gap-2 px-4 py-3">
          <form onSubmit={addUnit} className="space-y-2" aria-labelledby="deep-dive-add-unit">
            <h2 id="deep-dive-add-unit" className="text-sm font-semibold">Add a unit</h2>
            <div className="grid gap-2 sm:grid-cols-3">
              <Input aria-label="Unit name" placeholder="Operations" value={unitName} onChange={(event) => setUnitName(event.target.value)} />
              <NativeSelect aria-label="Unit type" value={unitType} onChange={(event) => setUnitType(event.target.value as DeepDiveUnitType)}>
                {DEEP_DIVE_UNIT_TYPES.map((type) => <option key={type} value={type}>{UNIT_TYPE_LABELS[type]}</option>)}
              </NativeSelect>
              <NativeSelect aria-label="Sits under" value={unitParent} onChange={(event) => setUnitParent(event.target.value)}>
                <option value="">At the top</option>
                {board.units.map((unit) => <option key={unit.id} value={unit.id}>Under {unit.name}</option>)}
              </NativeSelect>
            </div>
            <Button type="submit" size="sm" disabled={!unitName.trim() || writeMutation.isPending}>Add unit</Button>
          </form>
        </Card>
        <Card className="gap-2 px-4 py-3">
          <form onSubmit={addPerson} className="space-y-2" aria-labelledby="deep-dive-add-person">
            <h2 id="deep-dive-add-person" className="text-sm font-semibold">Add a person</h2>
            <div className="grid gap-2 sm:grid-cols-3">
              <Input aria-label="Person name" placeholder="Name" value={personName} onChange={(event) => setPersonName(event.target.value)} />
              <Input aria-label="Role" placeholder="Role, in their words" value={personRole} onChange={(event) => setPersonRole(event.target.value)} />
              <NativeSelect aria-label="Unit for the new person" value={personUnit} onChange={(event) => setPersonUnit(event.target.value)}>
                <option value="">Unplaced</option>
                {board.units.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
              </NativeSelect>
            </div>
            <Button type="submit" size="sm" disabled={!personName.trim() || writeMutation.isPending}>Add person</Button>
          </form>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <section aria-labelledby="deep-dive-units" className="space-y-2 lg:col-span-2">
          <h2 id="deep-dive-units" className="text-sm font-semibold">Units</h2>
          {tree.length > 0 ? (
            <ul className="space-y-2">
              {tree.map((node) => <UnitCard key={node.unit.id} node={node} siblings={tree} board={board} run={run} onPlace={place} />)}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No units yet. Add the first one above.</p>
          )}
        </section>
        <section
          aria-labelledby="deep-dive-unplaced"
          {...unplacedDrop.handlers}
          className={cn("space-y-2 rounded-lg border border-dashed border-border px-3 py-2", unplacedDrop.over && "border-ring ring-2 ring-ring/40")}
        >
          <h2 id="deep-dive-unplaced" className="text-sm font-semibold">Unplaced ({unplaced.length})</h2>
          <p className="text-xs text-muted-foreground">An unplaced person is a question to answer, not a tidy-up.</p>
          {unplaced.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">{unplaced.map((person) => <PersonChip key={person.id} person={person} />)}</ul>
          ) : (
            <p className="text-xs text-muted-foreground">Everyone is placed.</p>
          )}
        </section>
      </div>

      <section aria-labelledby="deep-dive-people" className="space-y-2">
        <h2 id="deep-dive-people" className="text-sm font-semibold">People and their tasks</h2>
        {board.people.length > 0 ? (
          <ul className="space-y-2">{board.people.map((person) => <PersonRow key={person.id} person={person} board={board} run={run} />)}</ul>
        ) : (
          <p className="text-sm text-muted-foreground">No people yet.</p>
        )}
      </section>
    </div>
  );
}

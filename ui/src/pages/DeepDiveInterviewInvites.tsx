import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEEP_DIVE_INTERVIEW_INVITE_LABELS,
  deepDiveInterviewReadiness,
  deepDiveInterviewSendKindFor,
  openDeepDiveInterviewRoundSchema,
  websiteUserIdSchema,
  type DeepDiveInterviewInvitee,
  type DeepDiveInterviewProgress,
  type DeepDiveInterviewProgressPerson,
  type DeepDiveInterviewRound,
  type DeepDiveInterviewStatusCounts,
} from "@greatstone/shared";
import { deepDiveInterviewsApi, deepDiveInterviewsQueryKeys } from "@/api/deepDiveInterviews";
import { deepDiveBoardsQueryKeys, deepDiveOrgApi } from "@/api/deepDiveBoards";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { StatusBadge } from "@/components/StatusBadge";

// Parallel Interview invites and live progress (GRE-2665). A person opens the
// round on the website once every question set is approved, then invites people
// from the organisation board or by hand. Names, emails and status are read live
// from the website; GSAM keeps only the website ids.

const INVITE_TONE = {
  invited: "pending",
  started: "running",
  completed: "succeeded",
  abandoned: "warning",
  declined: "rejected",
} as const;

/** The bar's colour per status, from the semantic status tokens. */
const BAR_TONE: Record<keyof DeepDiveInterviewStatusCounts, string> = {
  completed: "bg-status-success",
  started: "bg-status-running",
  invited: "bg-muted-foreground",
  abandoned: "bg-status-warning",
  declined: "bg-status-danger",
};
const BAR_ORDER = ["completed", "started", "invited", "abandoned", "declined"] as const;

function errorText(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

function useProgressWrite<TInput>(companyId: string, fn: (input: TInput) => Promise<DeepDiveInterviewProgress>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (progress) => {
      queryClient.setQueryData(deepDiveInterviewsQueryKeys.progress(companyId), progress);
      void queryClient.invalidateQueries({ queryKey: deepDiveInterviewsQueryKeys.round(companyId), exact: true });
    },
  });
}

// ---------------------------------------------------------------------------
// Open the round: refused until every question set is approved.
// ---------------------------------------------------------------------------

function OpenRound({ round, companyId }: { round: DeepDiveInterviewRound; companyId: string }) {
  const readiness = deepDiveInterviewReadiness(round);
  const [domains, setDomains] = useState("");
  const [seats, setSeats] = useState(String(Math.max(10, round.sets.length * 8)));
  const [formError, setFormError] = useState<string | null>(null);
  const open = useProgressWrite(companyId, (input: { allowedEmailDomains: string[]; seatTotal: number }) =>
    deepDiveInterviewsApi.open(round.id, input),
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = openDeepDiveInterviewRoundSchema.safeParse({
      allowedEmailDomains: domains.split(/[\s,]+/).filter(Boolean),
      seatTotal: Number(seats),
    });
    if (!parsed.success) {
      setFormError("Give at least one email domain, such as example.com, and a number of seats from 1.");
      return;
    }
    setFormError(null);
    open.mutate(parsed.data);
  }

  const shownError = formError ?? errorText(open.error);
  return (
    <Card className="gap-3 px-4 py-3">
      <form onSubmit={submit} noValidate className="space-y-3" aria-labelledby="interview-open">
        <h2 id="interview-open" className="text-sm font-semibold">Open the round on the website</h2>
        {readiness.ready ? (
          <p className="text-xs text-muted-foreground">
            Every question set is approved. Opening sends the round and its questions to the website, so invites can go out.
            The setup and the questions are then fixed.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground" role="status">
            {readiness.total === 0
              ? "Draft and approve a question set first. The round opens only when a person has approved every set."
              : `${readiness.approved} of ${readiness.total} question sets approved. The round opens only when a person has approved every set.`}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Email domains that may join</span>
            <Input
              autoComplete="off"
              spellCheck={false}
              placeholder="northwind.example"
              disabled={!readiness.ready}
              aria-invalid={formError ? true : undefined}
              value={domains}
              onChange={(event) => setDomains(event.target.value)}
            />
            <span className="block">The client's work domains, separated by commas.</span>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Seats</span>
            <Input
              type="number"
              min={1}
              inputMode="numeric"
              disabled={!readiness.ready}
              aria-invalid={formError ? true : undefined}
              value={seats}
              onChange={(event) => setSeats(event.target.value)}
            />
          </label>
        </div>
        {shownError ? <p role="alert" className="text-xs text-destructive">{shownError}</p> : null}
        <Button type="submit" size="sm" disabled={!readiness.ready || open.isPending}>
          {open.isPending ? "Opening..." : "Open the round"}
        </Button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Invite people: from the board, or by hand.
// ---------------------------------------------------------------------------

interface InviteRow {
  key: number;
  boardPersonId?: string;
  name: string;
  roleTitle: string;
  /** An email, or an existing website user id. */
  contact: string;
  unitId: string;
}

function toInvitee(row: InviteRow): DeepDiveInterviewInvitee {
  const contact = row.contact.trim();
  return {
    ...(row.boardPersonId ? { boardPersonId: row.boardPersonId } : { name: row.name.trim() }),
    ...(row.roleTitle.trim() && !row.boardPersonId ? { roleTitle: row.roleTitle.trim() } : {}),
    ...(contact.includes("@") ? { email: contact } : { websiteUserId: contact }),
    ...(row.unitId ? { unitId: row.unitId } : {}),
  };
}

function rowProblem(row: InviteRow, perTeam: boolean): string | null {
  const contact = row.contact.trim();
  const who = row.name.trim() || "Each person";
  if (!row.boardPersonId && !row.name.trim()) return "Give each person a name.";
  if (!contact) return `${who}: give an email, or the id of their existing website account.`;
  if (!contact.includes("@") && !websiteUserIdSchema.safeParse(contact).success) return `${who}: that is not an email or a website user id.`;
  if (perTeam && !row.unitId) return `${who}: choose the team whose questions they get.`;
  return null;
}

function InvitePeople({ round, companyId }: { round: DeepDiveInterviewRound; companyId: string }) {
  const queryClient = useQueryClient();
  const perTeam = round.mode === "per_team";
  const board = useQuery({ queryKey: deepDiveBoardsQueryKeys.organisation(companyId), queryFn: () => deepDiveOrgApi.get(companyId) });
  const teams = round.sets.filter((set) => set.target.kind === "unit").map((set) => set.target);
  const withSet = new Set(round.sets.map((set) => set.target.id));
  // Per person, only people with a question set; per team, any client person.
  const boardPeople = (board.data?.people ?? []).filter((p) => p.side === "client" && (perTeam || withSet.has(p.id)));
  const [rows, setRows] = useState<InviteRow[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [pick, setPick] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () => deepDiveInterviewsApi.invite(round.id, { people: rows.map(toInvitee) }),
    onSuccess: (result) => {
      queryClient.setQueryData(deepDiveInterviewsQueryKeys.progress(companyId), result.progress);
      setRows([]);
      setSent(
        `${result.invited} invited${result.emailed > 0 ? `, ${result.emailed} emailed the join link` : ""}${
          result.invited - result.created > 0 ? `; ${result.invited - result.created} already on the round` : ""
        }.`,
      );
    },
  });

  const unpicked = boardPeople.filter((p) => !rows.some((row) => row.boardPersonId === p.id));
  const teamFor = (unitId: string | null) => (unitId && teams.some((team) => team.id === unitId) ? unitId : "");

  function addRow(row: Omit<InviteRow, "key">) {
    setRows([...rows, { ...row, key: nextKey }]);
    setNextKey(nextKey + 1);
    setSent(null);
  }

  function addFromBoard() {
    const person = unpicked.find((p) => p.id === pick) ?? unpicked[0];
    if (!person) return;
    addRow({ boardPersonId: person.id, name: person.name, roleTitle: person.role, contact: "", unitId: teamFor(person.unitId) });
    setPick("");
  }

  function update(key: number, patch: Partial<InviteRow>) {
    setRows(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const problem = rows.map((row) => rowProblem(row, perTeam)).find(Boolean) ?? null;
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    invite.mutate();
  }

  const shownError = formError ?? errorText(invite.error);
  return (
    <Card className="gap-3 px-4 py-3">
      <form onSubmit={submit} noValidate className="space-y-3" aria-labelledby="interview-invite">
        <h2 id="interview-invite" className="text-sm font-semibold">Invite people</h2>
        <p className="text-xs text-muted-foreground">
          The website makes each person's account and emails them the join link, or uses their existing website account.
          GSAM keeps only their website id.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          {unpicked.length > 0 ? (
            <>
              <label className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">
                <span>From the organisation board</span>
                <NativeSelect value={pick || unpicked[0]!.id} onChange={(event) => setPick(event.target.value)}>
                  {unpicked.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}{p.role ? `, ${p.role}` : ""}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <Button type="button" size="sm" variant="outline" onClick={addFromBoard}>Add</Button>
            </>
          ) : board.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading the organisation board...</p>
          ) : null}
          {perTeam ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => addRow({ name: "", roleTitle: "", contact: "", unitId: teams[0]?.id ?? "" })}
            >
              Add someone by hand
            </Button>
          ) : null}
        </div>
        {board.error ? <p role="alert" className="text-xs text-destructive">{errorText(board.error)}</p> : null}

        {rows.length > 0 ? (
          <ul className="space-y-3">
            {rows.map((row, index) => (
              <li key={row.key} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_1fr_10rem_auto] sm:items-end">
                {row.boardPersonId ? (
                  <div className="min-w-0 text-sm">
                    <p className="break-words font-medium">{row.name}</p>
                    <p className="text-xs text-muted-foreground">{row.roleTitle || "From the board"}</p>
                  </div>
                ) : (
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>Name</span>
                    <Input value={row.name} onChange={(event) => update(row.key, { name: event.target.value })} />
                  </label>
                )}
                <label className="space-y-1 text-xs text-muted-foreground">
                  <span>Email or website user id</span>
                  <Input
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={`Email or website user id for person ${index + 1}`}
                    value={row.contact}
                    onChange={(event) => update(row.key, { contact: event.target.value })}
                  />
                </label>
                {perTeam ? (
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>Team</span>
                    <NativeSelect value={row.unitId} onChange={(event) => update(row.key, { unitId: event.target.value })}>
                      <option value="">Choose a team</option>
                      {teams.map((team) => (
                        <option key={team.id} value={team.id}>{team.name}</option>
                      ))}
                    </NativeSelect>
                  </label>
                ) : (
                  <span />
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${row.name || `person ${index + 1}`}`}
                  onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {shownError ? <p role="alert" className="text-xs text-destructive">{shownError}</p> : null}
        {sent ? <p role="status" className="text-xs text-muted-foreground">{sent}</p> : null}
        {rows.length > 0 ? (
          <Button type="submit" size="sm" disabled={invite.isPending}>
            {invite.isPending ? "Sending..." : `Send ${rows.length} ${rows.length === 1 ? "invite" : "invites"}`}
          </Button>
        ) : null}
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Live progress: per team and per person, read from the website.
// ---------------------------------------------------------------------------

function StatusBar({ counts, total }: { counts: DeepDiveInterviewStatusCounts; total: number }) {
  if (total === 0) return null;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
      {BAR_ORDER.map((status) =>
        counts[status] > 0 ? (
          <span key={status} className={BAR_TONE[status]} style={{ width: `${(counts[status] / total) * 100}%` }} />
        ) : null,
      )}
    </div>
  );
}

function countsText(counts: DeepDiveInterviewStatusCounts) {
  return BAR_ORDER.filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${DEEP_DIVE_INTERVIEW_INVITE_LABELS[status].toLowerCase()}`)
    .join(", ");
}

function PersonRow({ person, roundId, companyId }: { person: DeepDiveInterviewProgressPerson; roundId: string; companyId: string }) {
  const kind = person.invitedAt ? deepDiveInterviewSendKindFor(person.status) : null;
  const send = useProgressWrite(companyId, async () =>
    (await deepDiveInterviewsApi.send(roundId, { kind: kind!, websiteUserIds: [person.websiteUserId] })).progress,
  );
  const last = [
    person.lastSentAt ? `Sent ${formatDateTime(person.lastSentAt)}${person.sentCount > 1 ? ` (${person.sentCount} times)` : ""}` : null,
    person.lastRemindedAt ? `Reminded ${formatDateTime(person.lastRemindedAt)}` : null,
    person.endedAt ? `Ended ${formatDateTime(person.endedAt)}` : person.startedAt ? `Started ${formatDateTime(person.startedAt)}` : null,
  ].filter(Boolean);
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 py-2">
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-medium">{person.name || "Name not on the website"}</p>
        <p className="break-all text-xs text-muted-foreground">
          {[person.roleTitle, person.email].filter(Boolean).join(" · ")}
        </p>
        {last.length > 0 ? <p className="text-xs text-muted-foreground">{last.join(". ")}.</p> : null}
        {!person.invitedAt ? <p className="text-xs text-muted-foreground">Joined with the round's link.</p> : null}
        {send.error ? <p role="alert" className="text-xs text-destructive">{errorText(send.error)}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <StatusBadge status={INVITE_TONE[person.status]} label={DEEP_DIVE_INTERVIEW_INVITE_LABELS[person.status]} />
        {kind ? (
          <Button type="button" size="xs" variant="outline" disabled={send.isPending} onClick={() => send.mutate(undefined)}>
            {send.isPending ? "Sending..." : kind === "resend" ? "Resend" : "Remind"}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function Progress({ progress, roundId, companyId, onRefresh, refreshing }: {
  progress: DeepDiveInterviewProgress;
  roundId: string;
  companyId: string;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <section className="space-y-3" aria-labelledby="interview-progress">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="interview-progress" className="text-sm font-semibold">Progress</h2>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {progress.readAt ? <span>Read from the website {formatDateTime(progress.readAt)}</span> : null}
          <Button type="button" size="xs" variant="ghost" disabled={refreshing} onClick={onRefresh}>
            {refreshing ? "Reading..." : "Refresh"}
          </Button>
        </div>
      </div>
      {progress.total === 0 ? (
        <Card className="px-4 py-3">
          <p className="text-xs text-muted-foreground">Nobody is on the round yet. Invite people above.</p>
        </Card>
      ) : (
        <>
          <Card className="gap-2 px-4 py-3">
            <p className="text-sm" aria-live="polite">
              <span className="font-semibold">{progress.counts.completed} of {progress.total}</span> completed
              {progress.seatTotal ? <span className="text-muted-foreground"> · {progress.seatTotal} seats</span> : null}
            </p>
            <StatusBar counts={progress.counts} total={progress.total} />
            <p className="text-xs text-muted-foreground">{countsText(progress.counts)}</p>
          </Card>
          {progress.teams.map((team) => {
            const people = progress.people.filter((p) => p.unitId === team.unitId);
            const headingId = `interview-team-${team.unitId ?? "none"}`;
            return (
              <Card key={team.unitId ?? "none"} className="gap-2 px-4 py-3" aria-labelledby={headingId}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 id={headingId} className="break-words text-sm font-semibold">{team.name}</h3>
                  <span className="text-xs text-muted-foreground">{team.counts.completed} of {team.total} completed</span>
                </div>
                <StatusBar counts={team.counts} total={team.total} />
                <ul className="divide-y divide-border">
                  {people.map((person) => (
                    <PersonRow key={person.websiteUserId} person={person} roundId={roundId} companyId={companyId} />
                  ))}
                </ul>
              </Card>
            );
          })}
        </>
      )}
    </section>
  );
}

/** Below the question sets: open the round, invite, and watch progress. */
export function InterviewInvites({ round, companyId }: { round: DeepDiveInterviewRound; companyId: string }) {
  const live = round.status !== "setup";
  const progress = useQuery({
    queryKey: deepDiveInterviewsQueryKeys.progress(companyId),
    queryFn: () => deepDiveInterviewsApi.progress(companyId),
    enabled: live,
    refetchInterval: live ? 30_000 : false,
  });

  if (!live) return <OpenRound round={round} companyId={companyId} />;
  return (
    <div className="space-y-4">
      {round.status === "open" ? <InvitePeople round={round} companyId={companyId} /> : null}
      {progress.isLoading ? (
        <p className="text-xs text-muted-foreground">Reading progress from the website...</p>
      ) : progress.error && !progress.data ? (
        <Card className="gap-2 px-4 py-3">
          <p role="alert" className="text-xs text-destructive">{errorText(progress.error)}</p>
          <Button type="button" size="xs" variant="outline" className="self-start" onClick={() => void progress.refetch()}>
            Try again
          </Button>
        </Card>
      ) : progress.data ? (
        <>
          {progress.error ? (
            <p role="alert" className="text-xs text-destructive">
              Could not read the latest progress: {errorText(progress.error)} Showing the last read.
            </p>
          ) : null}
          <Progress
            progress={progress.data}
            roundId={round.id}
            companyId={companyId}
            onRefresh={() => void progress.refetch()}
            refreshing={progress.isFetching}
          />
        </>
      ) : null}
    </div>
  );
}

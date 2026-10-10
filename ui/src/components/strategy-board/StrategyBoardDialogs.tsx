import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StrategyBoardKpi, StrategyBoardMember, StrategyBoardPack } from "@greatstone/shared";
import { Download, Printer } from "lucide-react";
import { strategyBoardApi } from "@/api/strategyBoard";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { downloadMarkdown, boardOwnerName, packFileName, previousQuarter } from "@/lib/strategy-board";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

function invalidateBoard(queryClient: ReturnType<typeof useQueryClient>, companyId: string) {
  void queryClient.invalidateQueries({ queryKey: ["strategy-board", companyId] });
}

/** A board member asks the KPI owner to explain a slippage. */
export function AskWhyDialog({
  companyId,
  kpi,
  onClose,
}: {
  companyId: string;
  kpi: StrategyBoardKpi | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [question, setQuestion] = useState("");
  useEffect(() => setQuestion(""), [kpi?.goalId]);
  const ask = useMutation({
    mutationFn: () => strategyBoardApi.askWhy(kpi!.goalId, question.trim()),
    onSuccess: () => {
      invalidateBoard(queryClient, companyId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.strategyBoard.whyRequests(kpi!.goalId) });
      pushToast({ title: "Question sent", body: `${boardOwnerName(kpi!.owner)} has a task to answer it.`, tone: "success" });
      onClose();
    },
    onError: (err: Error) => pushToast({ title: "Question not sent", body: err.message, tone: "error" }),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (question.trim()) ask.mutate();
  };
  return (
    <Dialog open={kpi != null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Ask why: {kpi?.title}</DialogTitle>
            <DialogDescription>
              {boardOwnerName(kpi?.owner ?? null)} gets a task to explain. The answer is kept on the KPI and goes into the next board pack.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="why-question">Your question</Label>
            <Textarea
              id="why-question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Why is this behind plan, and what will bring it back?"
              rows={4}
              maxLength={5000}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!question.trim() || ask.isPending}>{ask.isPending ? "Sending…" : "Send question"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One click with a period (default: last full quarter) makes a frozen board pack. */
export function MakeBoardPackDialog({
  companyId,
  open,
  onClose,
  onCreated,
}: {
  companyId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (pack: StrategyBoardPack) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const quarter = previousQuarter();
  const [periodStart, setPeriodStart] = useState(quarter.periodStart);
  const [periodEnd, setPeriodEnd] = useState(quarter.periodEnd);
  const [title, setTitle] = useState(`${quarter.label} board pack`);
  const make = useMutation({
    mutationFn: () => strategyBoardApi.createPack(companyId, { periodStart, periodEnd, title: title.trim() || undefined }),
    onSuccess: (pack) => {
      invalidateBoard(queryClient, companyId);
      onCreated(pack);
    },
    onError: (err: Error) => pushToast({ title: "Board pack not made", body: err.message, tone: "error" }),
  });
  const invalid = !periodStart || !periodEnd || periodStart > periodEnd;
  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalid) make.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Make a board pack</DialogTitle>
            <DialogDescription>
              Status by area, slippages, owner explanations and the period's readings with their source. The pack is
              frozen: later corrections do not change it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="pack-title">Title</Label>
            <Input id="pack-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pack-start">From</Label>
              <Input id="pack-start" type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pack-end">To</Label>
              <Input id="pack-end" type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} />
            </div>
          </div>
          {invalid ? <p className="text-xs text-status-danger">The period must start on or before its end.</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={invalid || make.isPending}>{make.isPending ? "Making…" : "Make board pack"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function BoardPackViewer({ packId, onClose }: { packId: string | null; onClose: () => void }) {
  const { data: pack, isLoading, error } = useQuery({
    queryKey: queryKeys.strategyBoard.pack(packId ?? ""),
    queryFn: () => strategyBoardApi.getPack(packId!),
    enabled: !!packId,
  });
  return (
    <Dialog open={packId != null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{pack?.title ?? "Board pack"}</DialogTitle>
          <DialogDescription>
            {pack ? `${pack.periodStart} to ${pack.periodEnd} · made ${new Date(pack.createdAt).toLocaleDateString()}` : "Loading…"}
          </DialogDescription>
        </DialogHeader>
        {isLoading ? <p className="text-sm text-muted-foreground">Loading the pack…</p> : null}
        {error ? <p className="text-sm text-status-danger">Could not load the pack: {(error as Error).message}</p> : null}
        {pack ? (
          <>
            <div className="flex flex-wrap gap-2 print:hidden">
              <Button size="sm" variant="outline" onClick={() => downloadMarkdown(packFileName(pack.title), pack.body)}>
                <Download className="size-3.5" />
                Download
              </Button>
              <Button size="sm" variant="outline" onClick={() => window.print()}>
                <Printer className="size-3.5" />
                Print or save as PDF
              </Button>
            </div>
            <div className="overflow-x-auto">
              <MarkdownBody>{pack.body.replace(/^# .*\n+/, "")}</MarkdownBody>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", operator: "Operator", viewer: "Viewer" };

/**
 * Company owners choose the board: viewers can be board members, and one
 * board member or owner is chair (the chair gets the slippage alerts).
 */
export function BoardMembersCard({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { data: members, isLoading, error } = useQuery({
    queryKey: queryKeys.strategyBoard.members(companyId),
    queryFn: () => strategyBoardApi.members(companyId),
  });
  const [boardIds, setBoardIds] = useState<Set<string>>(new Set());
  const [chairId, setChairId] = useState<string>("");
  useEffect(() => {
    if (!members) return;
    setBoardIds(new Set(members.filter((m) => m.isBoardMember).map((m) => m.userId)));
    setChairId(members.find((m) => m.isChair)?.userId ?? "");
  }, [members]);
  const save = useMutation({
    mutationFn: () => {
      const entries = new Map<string, boolean>();
      for (const id of boardIds) entries.set(id, id === chairId);
      if (chairId) entries.set(chairId, true);
      return strategyBoardApi.setMembers(companyId, [...entries].map(([userId, chair]) => ({ userId, chair })));
    },
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.strategyBoard.members(companyId), next);
      invalidateBoard(queryClient, companyId);
      pushToast({ title: "Board saved", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: "Board not saved", body: err.message, tone: "error" }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading members…</p>;
  if (error) return <p className="text-sm text-status-danger">Could not load members: {(error as Error).message}</p>;
  const viewers = (members ?? []).filter((m) => m.role === "viewer");
  const chairOptions: StrategyBoardMember[] = (members ?? []).filter((m) => m.role === "owner" || boardIds.has(m.userId));
  const label = (m: StrategyBoardMember) => m.name ?? m.email ?? m.userId;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Board members read the strategy, ask "Why?" and make board packs. They cannot edit goals, run agents or change
        settings, so only people with the Viewer role can be chosen.
      </p>
      {viewers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No company member has the Viewer role yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {viewers.map((member) => (
            <li key={member.userId}>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={boardIds.has(member.userId)}
                  onCheckedChange={(checked) => {
                    const next = new Set(boardIds);
                    if (checked === true) next.add(member.userId);
                    else {
                      next.delete(member.userId);
                      if (chairId === member.userId) setChairId("");
                    }
                    setBoardIds(next);
                  }}
                  aria-label={`Board member: ${label(member)}`}
                />
                <span className="font-medium">{label(member)}</span>
                {member.email && member.name ? <span className="text-xs text-muted-foreground">{member.email}</span> : null}
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="board-chair">Chair (gets the slippage alerts)</Label>
        <NativeSelect id="board-chair" value={chairId} onChange={(event) => setChairId(event.target.value)}>
          <option value="">No chair: alerts are recorded but not sent</option>
          {chairOptions.map((member) => (
            <option key={member.userId} value={member.userId}>
              {label(member)} ({ROLE_LABEL[member.role] ?? member.role})
            </option>
          ))}
        </NativeSelect>
      </div>
      <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save board"}</Button>
    </div>
  );
}

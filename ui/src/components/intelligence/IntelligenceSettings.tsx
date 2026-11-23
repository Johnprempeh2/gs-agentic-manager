import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import {
  INTELLIGENCE_MAX_TOPICS,
  intelligenceTopicKey,
  type IntelligenceSettings,
  type IntelligenceTopic,
} from "@greatstone/shared";
import { ApiError } from "../../api/client";
import { intelligenceApi } from "../../api/intelligence";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

/** A topic as the form edits it: lists as text, one source per line, keywords by comma. */
interface DraftTopic {
  /** Empty until saved once: the key is made from the label then, and never changes after. */
  key: string;
  label: string;
  covers: string;
  sources: string;
  keywords: string;
  leaderboard: boolean;
  scoreLabel: string;
}

const toDraft = (topic: IntelligenceTopic): DraftTopic => ({
  key: topic.key,
  label: topic.label,
  covers: topic.covers,
  sources: topic.sources.join("\n"),
  keywords: topic.keywords.join(", "),
  leaderboard: topic.leaderboard,
  scoreLabel: topic.scoreLabel ?? "",
});

const lines = (text: string, separator: RegExp) =>
  [...new Set(text.split(separator).map((item) => item.trim()).filter(Boolean))];

/** Draft topics to the API shape; new topics get a key from their label. */
export function draftsToTopics(drafts: DraftTopic[]): IntelligenceTopic[] {
  const taken = new Set(drafts.map((draft) => draft.key).filter(Boolean));
  return drafts.map((draft) => {
    const key = draft.key || intelligenceTopicKey(draft.label, taken);
    taken.add(key);
    return {
      key,
      label: draft.label.trim(),
      covers: draft.covers.trim(),
      sources: lines(draft.sources, /\n/),
      keywords: lines(draft.keywords, /[,\n]/),
      leaderboard: draft.leaderboard,
      ...(draft.leaderboard && draft.scoreLabel.trim() ? { scoreLabel: draft.scoreLabel.trim() } : {}),
    };
  });
}

const emptyTopic = (): DraftTopic => ({ key: "", label: "", covers: "", sources: "", keywords: "", leaderboard: false, scoreLabel: "" });

function TopicFields({
  topic,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  topic: DraftTopic;
  index: number;
  count: number;
  onChange: (next: DraftTopic) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const id = `topic-${index}`;
  const name = topic.label.trim() || `Topic ${index + 1}`;
  return (
    <fieldset className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor={`${id}-label`}>Topic name</Label>
          <Input
            id={`${id}-label`}
            value={topic.label}
            maxLength={60}
            placeholder="For example: Investment banking"
            onChange={(event) => onChange({ ...topic, label: event.target.value })}
          />
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label={`Move ${name} up`} disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp className="size-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" aria-label={`Move ${name} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
          <ArrowDown className="size-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${name}`} onClick={onRemove}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-covers`}>What it covers</Label>
        <Textarea
          id={`${id}-covers`}
          rows={2}
          maxLength={600}
          value={topic.covers}
          placeholder="What your agent should look for, and why it matters to you"
          onChange={(event) => onChange({ ...topic, covers: event.target.value })}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-sources`}>Sources (one per line)</Label>
          <Textarea
            id={`${id}-sources`}
            rows={3}
            value={topic.sources}
            placeholder={"Financial Times\nreuters.com"}
            onChange={(event) => onChange({ ...topic, sources: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-keywords`}>Keywords (comma separated)</Label>
          <Textarea
            id={`${id}-keywords`}
            rows={3}
            value={topic.keywords}
            placeholder="M&A, IPO, graduate roles"
            onChange={(event) => onChange({ ...topic, keywords: event.target.value })}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-sm">
          <ToggleSwitch
            checked={topic.leaderboard}
            onCheckedChange={(leaderboard) => onChange({ ...topic, leaderboard })}
            aria-label={`Rank ${name} on a leaderboard`}
          />
          Rank it on a leaderboard
        </label>
        {topic.leaderboard ? (
          <div className="flex items-center gap-2">
            <Label htmlFor={`${id}-score`} className="text-xs text-muted-foreground">Score called</Label>
            <Input
              id={`${id}-score`}
              className="h-8 w-28"
              maxLength={20}
              value={topic.scoreLabel}
              placeholder="Score"
              onChange={(event) => onChange({ ...topic, scoreLabel: event.target.value })}
            />
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}

/** The owner's editor for what the Intelligence page follows: topics in page order, plus the Pulse headings. */
export function IntelligenceSettingsDialog({
  companyId,
  settings,
  open,
  onOpenChange,
}: {
  companyId: string;
  settings: IntelligenceSettings | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [topics, setTopics] = useState<DraftTopic[]>([]);
  const [trendsTitle, setTrendsTitle] = useState("");
  const [opportunitiesTitle, setOpportunitiesTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const current = settings?.topics ?? [];
    setTopics(current.length ? current.map(toDraft) : [emptyTopic()]);
    setTrendsTitle(settings?.sectionTitles.trends ?? "");
    setOpportunitiesTitle(settings?.sectionTitles.opportunities ?? "");
    setError(null);
  }, [open, settings]);

  const save = useMutation({
    mutationFn: () =>
      intelligenceApi.saveSettings(companyId, {
        topics: draftsToTopics(topics.filter((topic) => topic.label.trim())),
        sectionTitles: {
          ...(trendsTitle.trim() ? { trends: trendsTitle.trim() } : {}),
          ...(opportunitiesTitle.trim() ? { opportunities: opportunitiesTitle.trim() } : {}),
        },
      }),
    onSuccess: async (saved) => {
      queryClient.setQueryData(queryKeys.intelligence.settings(companyId), saved);
      await queryClient.invalidateQueries({ queryKey: queryKeys.intelligence.all(companyId) });
      onOpenChange(false);
    },
    onError: (err) =>
      setError(
        err instanceof ApiError && err.status === 403
          ? "Only the owner or an admin can change the topics."
          : err instanceof ApiError
            ? err.message
            : "The topics did not save. Try again.",
      ),
  });

  const update = (index: number, next: DraftTopic) => setTopics((all) => all.map((topic, i) => (i === index ? next : topic)));
  const move = (index: number, by: -1 | 1) =>
    setTopics((all) => {
      const next = [...all];
      const [item] = next.splice(index, 1);
      next.splice(index + by, 0, item!);
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-(--sz-85vh) sm:max-w-2xl"
        scrollBody
        footer={
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
            {error ? <p role="alert" className="text-sm text-status-danger sm:mr-auto">{error}</p> : null}
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving" : "Save topics"}
            </Button>
          </div>
        }
      >
        <DialogHeader>
          <DialogTitle>Intelligence topics</DialogTitle>
          <DialogDescription>
            Your intelligence agent reads these before each morning run: what to follow, where to look and which words
            matter. The page shows them in this order.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {topics.map((topic, index) => (
            <TopicFields
              key={index}
              topic={topic}
              index={index}
              count={topics.length}
              onChange={(next) => update(index, next)}
              onMove={(by) => move(index, by)}
              onRemove={() => setTopics((all) => all.filter((_, i) => i !== index))}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={topics.length >= INTELLIGENCE_MAX_TOPICS}
            onClick={() => setTopics((all) => [...all, emptyTopic()])}
          >
            <Plus className="size-3.5" />
            Add a topic
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="pulse-trends-title">Daily Pulse: trends heading</Label>
            <Input id="pulse-trends-title" maxLength={60} value={trendsTitle} placeholder="Trends" onChange={(event) => setTrendsTitle(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pulse-opportunities-title">Daily Pulse: opportunities heading</Label>
            <Input id="pulse-opportunities-title" maxLength={60} value={opportunitiesTitle} placeholder="Opportunities" onChange={(event) => setOpportunitiesTitle(event.target.value)} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

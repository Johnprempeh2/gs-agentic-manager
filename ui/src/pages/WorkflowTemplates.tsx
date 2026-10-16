import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RESEARCH_PACK_WORKFLOW_TEMPLATE_PRESET,
  type Agent,
  type WorkflowTemplate,
  type WorkflowTemplateDefinition,
} from "@greatstone/shared";
import { Play, Plus, Workflow } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { workflowTemplatesApi } from "../api/workflowTemplates";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { issueUrl } from "../lib/utils";
import { parseDefinitionText, reviewsByStep, withAssignee, workflowTemplateSummary } from "../lib/workflow-templates";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function AgentSelect({
  id,
  value,
  agents,
  onChange,
}: {
  id: string;
  value: string | null | undefined;
  agents: Agent[];
  onChange: (agentId: string | null) => void;
}) {
  return (
    <NativeSelect id={id} value={value ?? ""} onChange={(event) => onChange(event.target.value || null)} className="sm:w-56">
      <option value="">Unassigned</option>
      {agents.map((agent) => (
        <option key={agent.id} value={agent.id}>
          {agent.name}
        </option>
      ))}
    </NativeSelect>
  );
}

function TemplateCard({
  template,
  agents,
  onStart,
}: {
  template: WorkflowTemplate;
  agents: Agent[];
  onStart: () => void;
}) {
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<WorkflowTemplateDefinition>(template.definition);
  const [jsonText, setJsonText] = useState<string | null>(null);
  useEffect(() => setDraft(template.definition), [template.definition]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(template.definition);
  const parsedJson = jsonText === null ? null : parseDefinitionText(jsonText);
  const reviews = useMemo(() => reviewsByStep(draft), [draft]);

  const save = useMutation({
    mutationFn: (definition: WorkflowTemplateDefinition) => workflowTemplatesApi.update(template.id, { definition }),
    onSuccess: () => {
      setJsonText(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflowTemplates.list(template.companyId) });
      pushToast({ title: "Template saved", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: "Could not save the template", body: err.message, tone: "error" }),
  });

  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{template.name}</h2>
          {template.description ? <p className="text-sm text-muted-foreground">{template.description}</p> : null}
          <p className="mt-1 text-xs text-muted-foreground">{workflowTemplateSummary(draft)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setJsonText(jsonText === null ? JSON.stringify(draft, null, 2) : null)}>
            {jsonText === null ? "Edit as JSON" : "Close JSON"}
          </Button>
          <Button size="sm" onClick={onStart} disabled={dirty}>
            <Play className="size-3.5" />
            Start
          </Button>
        </div>
      </header>

      {jsonText !== null ? (
        <div className="space-y-2">
          <Textarea
            aria-label={`${template.name} definition`}
            value={jsonText}
            onChange={(event) => setJsonText(event.target.value)}
            className="min-h-80 font-mono text-xs"
          />
          {parsedJson && !parsedJson.ok ? <p className="text-sm text-destructive">{parsedJson.error}</p> : null}
          <Button
            size="sm"
            disabled={!parsedJson?.ok || save.isPending}
            onClick={() => parsedJson?.ok && save.mutate(parsedJson.definition)}
          >
            Save JSON
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <Label htmlFor={`${template.id}-coordinator`}>Coordinator issue</Label>
            <AgentSelect
              id={`${template.id}-coordinator`}
              value={draft.coordinator.assigneeAgentId}
              agents={agents}
              onChange={(agentId) => setDraft(withAssignee(draft, null, agentId))}
            />
          </div>
          <ol className="divide-y divide-border rounded-md border border-border">
            {draft.steps.map((step, index) => (
              <li key={step.key} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <Label htmlFor={`${template.id}-${step.key}`} className="text-sm font-medium">
                    {index + 1}. {step.title}
                  </Label>
                  <div className="flex flex-wrap gap-1">
                    {step.documents.map((doc) => (
                      <Badge key={doc.key} variant="outline" className="font-mono text-(length:--text-micro)">
                        {doc.key}
                      </Badge>
                    ))}
                    {(reviews.get(step.key) ?? []).map((review) => (
                      <Badge key={review.key} variant="secondary">
                        {review.label}
                      </Badge>
                    ))}
                  </div>
                  {step.blockedBy.length > 0 ? (
                    <p className="text-xs text-muted-foreground">After {step.blockedBy.join(", ")}</p>
                  ) : null}
                </div>
                <AgentSelect
                  id={`${template.id}-${step.key}`}
                  value={step.assigneeAgentId}
                  agents={agents}
                  onChange={(agentId) => setDraft(withAssignee(draft, step.key, agentId))}
                />
              </li>
            ))}
          </ol>
          {dirty ? (
            <div className="flex gap-2">
              <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(draft)}>
                {save.isPending ? "Saving…" : "Save assignees"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDraft(template.definition)}>
                Discard
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function StartDialog({
  template,
  companyId,
  onClose,
}: {
  template: WorkflowTemplate | null;
  companyId: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");
  const [reviewerUserId, setReviewerUserId] = useState("");
  useEffect(() => {
    if (template) setTitle("");
  }, [template]);

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: !!template,
  });
  const { data: directory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    enabled: !!template,
  });
  const members = (directory?.users ?? []).filter((entry) => entry.status === "active" && entry.user);

  const start = useMutation({
    mutationFn: () =>
      workflowTemplatesApi.start(template!.id, {
        title: title.trim(),
        projectId: projectId || null,
        reviewerUserId: reviewerUserId || null,
      }),
    onSuccess: (result) => {
      pushToast({
        title: `${result.coordinator.identifier ?? "Pack"} started`,
        body: `${result.steps.length} step issues created.`,
        tone: "success",
      });
      onClose();
      navigate(issueUrl(result.coordinator));
    },
    onError: (err: Error) => pushToast({ title: "Could not start the pack", body: err.message, tone: "error" }),
  });

  return (
    <Dialog open={!!template} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start {template?.name}</DialogTitle>
          <DialogDescription>
            Creates the coordinator issue, {template?.definition.steps.length ?? 0} step issues, the human checks and the
            empty documents.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim()) start.mutate();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="workflow-start-title">Title</Label>
            <Input id="workflow-start-title" value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
          </div>
          <div className="space-y-1">
            <Label htmlFor="workflow-start-project">Project</Label>
            <NativeSelect id="workflow-start-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">No project</option>
              {(projects ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="workflow-start-reviewer">Reviewer for the human checks</Label>
            <NativeSelect
              id="workflow-start-reviewer"
              value={reviewerUserId}
              onChange={(event) => setReviewerUserId(event.target.value)}
            >
              <option value="">Me</option>
              {members.map((entry) => (
                <option key={entry.principalId} value={entry.principalId}>
                  {entry.user?.name ?? entry.user?.email ?? entry.principalId}
                </option>
              ))}
            </NativeSelect>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || start.isPending}>
              {start.isPending ? "Starting…" : "Start"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WorkflowTemplates() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [starting, setStarting] = useState<WorkflowTemplate | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Workflows" }]);
  }, [setBreadcrumbs]);

  const { data: templates, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.workflowTemplates.list(selectedCompanyId!),
    queryFn: () => workflowTemplatesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const activeAgents = useMemo(() => (agents ?? []).filter((agent) => agent.status !== "terminated"), [agents]);

  const addResearchPack = useMutation({
    mutationFn: () => workflowTemplatesApi.create(selectedCompanyId!, RESEARCH_PACK_WORKFLOW_TEMPLATE_PRESET),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflowTemplates.list(selectedCompanyId!) });
      pushToast({ title: "Research pack template added", body: "Choose who does each step, then start a pack.", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: "Could not add the template", body: err.message, tone: "error" }),
  });

  if (!selectedCompanyId) return <EmptyState icon={Workflow} message="Select an organization to view workflows." />;
  if (isLoading) return <PageSkeleton variant="list" />;
  if (error && !templates) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const hasResearchPack = (templates ?? []).some((template) => template.key === RESEARCH_PACK_WORKFLOW_TEMPLATE_PRESET.key);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Workflows</p>
          <h1 className="text-xl font-bold">Start a set of tasks from a template</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            One click creates the coordinator task, its step tasks, the human checks and the empty documents.
          </p>
        </div>
        {templates && templates.length > 0 && !hasResearchPack ? (
          <Button size="sm" variant="outline" disabled={addResearchPack.isPending} onClick={() => addResearchPack.mutate()}>
            <Plus className="size-3.5" />
            Research pack template
          </Button>
        ) : null}
      </header>

      {templates && templates.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No workflow templates yet"
          message="Add the research pack template, then choose who does each step."
          action={addResearchPack.isPending ? "Adding…" : "Add research pack template"}
          onAction={() => addResearchPack.mutate()}
        />
      ) : null}

      {(templates ?? []).map((template) => (
        <TemplateCard key={template.id} template={template} agents={activeAgents} onStart={() => setStarting(template)} />
      ))}

      <StartDialog template={starting} companyId={selectedCompanyId} onClose={() => setStarting(null)} />
    </div>
  );
}

import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { workflowTemplates } from "@greatstone/db";
import {
  workflowTemplateDefinitionSchema,
  type CreateWorkflowTemplate,
  type IssueExecutionPolicy,
  type StartWorkflowTemplate,
  type UpdateWorkflowTemplate,
  type WorkflowTemplate,
  type WorkflowTemplateDefinition,
  type WorkflowTemplateStartResult,
  type WorkflowTemplateStartedIssue,
  type WorkflowTemplateStartedStep,
} from "@greatstone/shared";
import { conflict, unprocessable } from "../errors.js";
import { documentService } from "./documents.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { issueService } from "./issues.js";

export interface WorkflowTemplateActor {
  agentId: string | null;
  userId: string | null;
  runId: string | null;
  /** The user an agent acts for; the issue's responsible user. */
  responsibleUserId?: string | null;
}

type WorkflowTemplateRow = typeof workflowTemplates.$inferSelect;

function toTemplate(row: WorkflowTemplateRow): WorkflowTemplate {
  return { ...row, definition: row.definition as unknown as WorkflowTemplateDefinition };
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

/** Review stages for one step, in template order. Empty participants fall back to the pack reviewer. */
function stepExecutionPolicy(
  definition: WorkflowTemplateDefinition,
  stepKey: string,
  reviewerUserId: string | null,
): { policy: IssueExecutionPolicy | null; reviewKeys: string[] } {
  const reviews = definition.reviews.filter((review) => review.stepKey === stepKey);
  if (reviews.length === 0) return { policy: null, reviewKeys: [] };
  const stages = reviews.map((review) => {
    const participants = review.participants.length > 0
      ? review.participants
      : reviewerUserId
        ? [{ type: "user" as const, userId: reviewerUserId }]
        : [];
    if (participants.length === 0) {
      throw unprocessable(`"${review.label}" has no reviewer. Choose a reviewer for the pack or set one in the template.`);
    }
    return { type: review.type, participants };
  });
  return {
    policy: normalizeIssueExecutionPolicy({ mode: "normal", commentRequired: true, stages }),
    reviewKeys: reviews.map((review) => review.key),
  };
}

function coordinatorDescription(template: WorkflowTemplate, input: StartWorkflowTemplate) {
  const { definition } = template;
  const lines: string[] = [];
  if (input.description?.trim()) lines.push(input.description.trim(), "");
  if (definition.coordinator.description?.trim()) lines.push(definition.coordinator.description.trim(), "");
  lines.push(`Started from the workflow template "${template.name}".`, "", "**Steps**");
  definition.steps.forEach((step, index) => {
    const waits = step.blockedBy.length > 0 ? ` (after ${step.blockedBy.join(", ")})` : "";
    lines.push(`${index + 1}. ${step.title}${waits}`);
  });
  if (definition.reviews.length > 0) {
    lines.push("", "**Human checks**");
    for (const review of definition.reviews) {
      const step = definition.steps.find((candidate) => candidate.key === review.stepKey);
      lines.push(`- ${review.label}: ${review.type} before "${step?.title ?? review.stepKey}" is done`);
    }
  }
  return lines.join("\n");
}

export function workflowTemplateService(db: Db) {
  async function getById(id: string) {
    const [row] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, id));
    return row ? toTemplate(row) : null;
  }

  return {
    getById,

    list: async (companyId: string, opts: { includeArchived?: boolean } = {}) => {
      const rows = await db
        .select()
        .from(workflowTemplates)
        .where(
          opts.includeArchived
            ? eq(workflowTemplates.companyId, companyId)
            : and(eq(workflowTemplates.companyId, companyId), isNull(workflowTemplates.archivedAt)),
        )
        .orderBy(asc(workflowTemplates.name));
      return rows.map(toTemplate);
    },

    create: async (companyId: string, input: CreateWorkflowTemplate, actor: WorkflowTemplateActor) => {
      try {
        const [row] = await db
          .insert(workflowTemplates)
          .values({
            companyId,
            key: input.key,
            name: input.name,
            description: input.description ?? null,
            definition: input.definition as unknown as Record<string, unknown>,
            createdByAgentId: actor.agentId,
            createdByUserId: actor.userId,
            updatedByAgentId: actor.agentId,
            updatedByUserId: actor.userId,
          })
          .returning();
        return toTemplate(row);
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict(`A workflow template with key "${input.key}" already exists`);
        throw error;
      }
    },

    update: async (id: string, input: UpdateWorkflowTemplate, actor: WorkflowTemplateActor) => {
      const patch: Partial<typeof workflowTemplates.$inferInsert> = {
        updatedAt: new Date(),
        updatedByAgentId: actor.agentId,
        updatedByUserId: actor.userId,
      };
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.definition !== undefined) patch.definition = input.definition as unknown as Record<string, unknown>;
      if (input.archived !== undefined) patch.archivedAt = input.archived ? new Date() : null;
      const [row] = await db.update(workflowTemplates).set(patch).where(eq(workflowTemplates.id, id)).returning();
      return row ? toTemplate(row) : null;
    },

    /**
     * Creates the coordinator issue, one child issue per step (with assignee and
     * blockers), each step's review stages and every empty document slot, in one
     * transaction. Any failure rolls the whole pack back. Wakeups and activity are
     * the caller's job, after commit.
     */
    start: async (
      template: WorkflowTemplate,
      input: StartWorkflowTemplate,
      actor: WorkflowTemplateActor,
    ): Promise<WorkflowTemplateStartResult> => {
      if (template.archivedAt) throw unprocessable("This workflow template is archived");
      // Stored definitions were validated on write; parse again so an older or hand-edited row fails here, not halfway.
      const parsed = workflowTemplateDefinitionSchema.safeParse(template.definition);
      if (!parsed.success) throw unprocessable("This workflow template is not valid. Edit it and save again.", parsed.error.issues);
      const definition = parsed.data;
      const reviewerUserId = input.reviewerUserId ?? actor.userId ?? null;
      const stepPolicies = new Map(
        definition.steps.map((step) => [step.key, stepExecutionPolicy(definition, step.key, reviewerUserId)]),
      );
      const companyId = template.companyId;
      const createdBy = {
        createdByAgentId: actor.agentId,
        createdByUserId: actor.agentId ? null : actor.userId,
        actorRunId: actor.runId,
        originRunId: actor.runId,
        actorResponsibleUserId: actor.responsibleUserId,
        trustExplicitResponsibleUserId: !actor.agentId,
        allowDuplicate: true,
      };

      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const issues = issueService(txDb);
        const documents = documentService(txDb);

        async function createSlots(issueId: string, slots: Array<{ key: string; title: string }>) {
          for (const slot of slots) {
            await documents.upsertIssueDocument({
              issueId,
              key: slot.key,
              title: slot.title,
              format: "markdown",
              body: "",
              changeSummary: `Empty slot from workflow template "${template.name}"`,
              createdByAgentId: actor.agentId,
              createdByUserId: actor.agentId ? null : actor.userId,
              createdByRunId: actor.runId,
            });
          }
          return slots.map((slot) => slot.key);
        }

        const coordinatorIssue = await issues.create(companyId, {
          ...createdBy,
          title: input.title,
          description: coordinatorDescription(template, input),
          status: "todo",
          priority: "medium",
          assigneeAgentId: definition.coordinator.assigneeAgentId ?? null,
          projectId: input.projectId ?? null,
          goalId: input.goalId ?? null,
          parentId: input.parentId ?? null,
        });
        const coordinator: WorkflowTemplateStartedIssue = {
          id: coordinatorIssue.id,
          identifier: coordinatorIssue.identifier ?? null,
          title: coordinatorIssue.title,
          status: coordinatorIssue.status,
          assigneeAgentId: coordinatorIssue.assigneeAgentId ?? null,
          documentKeys: await createSlots(coordinatorIssue.id, definition.coordinator.documents),
        };

        const issueIdByStep = new Map<string, string>();
        const steps: WorkflowTemplateStartedStep[] = [];
        for (const step of definition.steps) {
          const { policy, reviewKeys } = stepPolicies.get(step.key)!;
          const blockedByIssueIds = step.blockedBy.map((key) => issueIdByStep.get(key)!);
          const created = await issues.create(companyId, {
            ...createdBy,
            title: `${input.title}: ${step.title}`,
            description: step.description ?? null,
            status: blockedByIssueIds.length > 0 ? "blocked" : "todo",
            priority: "medium",
            assigneeAgentId: step.assigneeAgentId ?? null,
            parentId: coordinatorIssue.id,
            projectId: coordinatorIssue.projectId ?? null,
            goalId: coordinatorIssue.goalId ?? null,
            executionPolicy: policy as Record<string, unknown> | null,
            ...(blockedByIssueIds.length > 0 ? { blockedByIssueIds } : {}),
          });
          issueIdByStep.set(step.key, created.id);
          steps.push({
            stepKey: step.key,
            id: created.id,
            identifier: created.identifier ?? null,
            title: created.title,
            status: created.status,
            assigneeAgentId: created.assigneeAgentId ?? null,
            blockedByStepKeys: step.blockedBy,
            reviewKeys,
            documentKeys: await createSlots(created.id, step.documents),
          });
        }

        return { templateId: template.id, coordinator, steps };
      });
    },
  };
}


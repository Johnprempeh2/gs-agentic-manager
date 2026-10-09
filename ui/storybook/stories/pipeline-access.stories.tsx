import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PipelineAccessMatrix } from "@greatstone/shared";
import { AgentPipelinesAccessSection } from "@/components/AgentPipelinesAccessSection";
import { PipelineAgentAccessSection } from "@/components/PipelineAgentAccessSection";
import { PipelineAccessOverview } from "@/pages/PipelineAccessOverview";
import { queryKeys } from "@/lib/queryKeys";

const COMPANY_ID = "company-storybook";
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const grace = (hours: number) => ({ at: hoursAgo(hours), actorType: "user", actorId: "user-grace", actorName: "Grace Owner" });
const alan = (hours: number) => ({ at: hoursAgo(hours), actorType: "user", actorId: "user-alan", actorName: "Alan Admin" });

const matrix: PipelineAccessMatrix = {
  canManage: true,
  canCreatePipelines: true,
  administerPipelineIds: ["p-sales", "p-support", "p-onboarding", "p-renewals"],
  pipelines: [
    { id: "p-sales", name: "Sales", archivedAt: null },
    { id: "p-support", name: "Support", archivedAt: null },
    { id: "p-onboarding", name: "Onboarding", archivedAt: null },
    { id: "p-renewals", name: "Renewals", archivedAt: null },
  ],
  agents: [
    {
      agentId: "agent-harbor",
      name: "Harbor",
      role: "general",
      status: "idle",
      levels: { "p-sales": "administer", "p-support": "work_cases", "p-onboarding": "view", "p-renewals": "work_cases" },
      allPipelinesLevel: null,
      lastChange: alan(1),
      lastChanges: { "p-sales": grace(26), "p-support": alan(1), "p-onboarding": null, "p-renewals": alan(5) },
    },
    {
      agentId: "agent-ridge",
      name: "Ridge",
      role: "engineer",
      status: "idle",
      levels: { "p-sales": "work_cases", "p-support": "work_cases", "p-onboarding": "work_cases", "p-renewals": "work_cases" },
      allPipelinesLevel: "work_cases",
      lastChange: grace(3),
      lastChanges: { "p-sales": grace(3), "p-support": grace(3), "p-onboarding": grace(3), "p-renewals": grace(3) },
    },
    {
      agentId: "agent-summit",
      name: "Summit",
      role: "general",
      status: "idle",
      levels: { "p-sales": "view", "p-support": "view", "p-onboarding": "view", "p-renewals": "view" },
      allPipelinesLevel: "view",
      lastChange: null,
      lastChanges: { "p-sales": null, "p-support": null, "p-onboarding": null, "p-renewals": null },
    },
  ],
};

function Seeded({ data, children }: { data: PipelineAccessMatrix; children: ReactNode }) {
  const queryClient = useQueryClient();
  useState(() => queryClient.setQueryData(queryKeys.pipelineAccess(COMPANY_ID), data));
  return <div className="p-4">{children}</div>;
}

const meta: Meta = { title: "Pipelines/Agent pipeline access (GRE-1073)" };
export default meta;
type Story = StoryObj;

export const Overview: Story = {
  render: () => (
    <Seeded data={matrix}>
      <PipelineAccessOverview />
    </Seeded>
  ),
};

export const PipelineView: Story = {
  render: () => (
    <Seeded data={matrix}>
      <PipelineAgentAccessSection companyId={COMPANY_ID} pipelineId="p-sales" pipelineName="Sales" />
    </Seeded>
  ),
};

export const AgentView: Story = {
  render: () => (
    <Seeded data={matrix}>
      <div className="max-w-2xl">
        <AgentPipelinesAccessSection companyId={COMPANY_ID} agentId="agent-harbor" agentName="Harbor" />
      </div>
    </Seeded>
  ),
};

export const OverviewReadOnly: Story = {
  render: () => (
    <Seeded data={{ ...matrix, canManage: false, canCreatePipelines: false, administerPipelineIds: [] }}>
      <PipelineAccessOverview />
    </Seeded>
  ),
};

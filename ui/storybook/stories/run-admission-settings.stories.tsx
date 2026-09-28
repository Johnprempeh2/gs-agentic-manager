import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type { InstanceSystemMemory } from "@greatstone/shared";
import type { RunAdmissionRecommendation } from "@/api/instanceSettings";
import { RunAdmissionSettingsSection } from "@/components/RunAdmissionSettingsSection";
import { queryKeys } from "@/lib/queryKeys";

const GB = 1024 * 1024 * 1024;

const memory: InstanceSystemMemory = {
  totalBytes: 16 * GB,
  availableBytes: 5 * GB,
  pressure: "normal",
} as InstanceSystemMemory;

const noUsage: RunAdmissionRecommendation = {
  windowDays: 7,
  current: { maxConcurrentRuns: 4, minAvailableMemoryMb: 3072 },
  suggested: { maxConcurrentRuns: 26, minAvailableMemoryMb: 3072 },
  reasons: ["No runs in the last 7 days; the suggestion uses the RAM rule only."],
  usage: {
    runsStarted: 0,
    peakConcurrentRuns: 0,
    holds: { globalCap: { runs: 0 }, lowMemory: { runs: 0 } },
  },
};

const withUsage: RunAdmissionRecommendation = {
  ...noUsage,
  suggested: { maxConcurrentRuns: 5, minAvailableMemoryMb: 3072 },
  reasons: [
    "RAM rule: (16384 MB total - 3072 MB floor) / 500 MB per run = 26 runs.",
    "Memory use per run is not recorded, so runs are sized at about 500 MB each (RAM rule only).",
    "4 runs waited on the run cap while free RAM stayed above the floor; raise the cap by one to 5.",
    "Hold reasons are counted since 2026-09-28T08:00:00.000Z (server start or window start, whichever is later).",
  ],
  usage: {
    runsStarted: 40,
    peakConcurrentRuns: 4,
    holds: { globalCap: { runs: 4 }, lowMemory: { runs: 0 } },
  },
};

function Seeded({
  recommendation,
  children,
}: {
  recommendation: RunAdmissionRecommendation;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  useState(() => {
    queryClient.setQueryData(queryKeys.instance.systemMemory, memory);
    queryClient.setQueryData(queryKeys.instance.runAdmissionRecommendation, recommendation);
  });
  return <div className="max-w-3xl p-6">{children}</div>;
}

function Section({ recommendation }: { recommendation: RunAdmissionRecommendation }) {
  const [runAdmission, setRunAdmission] = useState(recommendation.current);
  return (
    <Seeded recommendation={recommendation}>
      <RunAdmissionSettingsSection runAdmission={runAdmission} disabled={false} onSave={setRunAdmission} />
    </Seeded>
  );
}

const meta = {
  title: "Instance/Run limits",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const UsageRecommendation: Story = {
  render: () => <Section recommendation={withUsage} />,
};

export const NoUsageYet: Story = {
  render: () => <Section recommendation={noUsage} />,
};

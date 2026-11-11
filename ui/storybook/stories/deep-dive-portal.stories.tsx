import { useEffect, useState } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { DeepDiveDraft, DeepDiveRecordSummary } from "@greatstone/shared";
import { deepDiveRecordsQueryKeys } from "@/api/deepDiveRecords";
import { useCompany } from "@/context/CompanyContext";
import { DeepDivePortal } from "@/pages/DeepDivePortal";
import { DeepDiveTiles } from "@/pages/DeepDiveTiles";

// GRE-4430: one Deep Dive per client engagement. Demo clients only, never a real one.

const COMPANY_ID = "company-storybook";

const record = (id: string, clientName: string, overrides: Partial<DeepDiveRecordSummary> = {}): DeepDiveRecordSummary => ({
  id,
  identifier: `PAP-C${id.slice(-1)}`,
  title: `Deep Dive: ${clientName}`,
  clientCaseId: `client-${id}`,
  clientName,
  organisationId: `org-${id}`,
  workstreams: ["Evidence confirmation", "Service operations", "Commercial economics"],
  status: "active",
  draftsWaiting: 0,
  findingsToValidate: 0,
  createdAt: "2026-11-02T09:00:00.000Z",
  ...overrides,
});

const RECORDS = [
  record("record-1", "Northwind Freight (demo)", { draftsWaiting: 2, findingsToValidate: 3 }),
  record("record-2", "Harbour Clinics (demo)", { findingsToValidate: 1, workstreams: [] }),
  record("record-3", "Meridian Foods (demo)"),
  record("record-4", "Northwind Freight (demo, 2025)", { status: "finished", createdAt: "2025-05-01T09:00:00.000Z" }),
];

const DRAFTS: DeepDiveDraft[] = [
  {
    id: "draft-1",
    companyId: COMPANY_ID,
    recordCaseId: "record-1",
    kind: "interview_log",
    title: "Finance lead interview (2026-11-12)",
    payload: {
      notionPage: "https://www.notion.so/demo-meeting",
      meetingTitle: "Finance lead interview",
      heldOn: "2026-11-12",
      interviewee: "Demo Person, Finance lead",
      questionSource: "Interview guide v3",
      items: [
        { question: "How is a month closed today?", status: "answered", answer: "By hand in spreadsheets over about five days.", quote: "We close the month by hand, it takes about five days.", at: "00:04:10", workstream: "Commercial economics", pillars: ["process", "data"] },
        { question: "Which system holds the ledger?", status: "unclear", answer: "Two systems were named; which is the master was not said.", at: "00:09:32", workstream: "Commercial economics" },
        { question: "Who signs off the forecast?", status: "not_answered", workstream: "Commercial economics" },
        { question: "Where do service requests come in?", status: "answered", answer: "Email and phone, logged later.", quote: "Most come by email, some by phone, we log them at the end of the day.", at: "00:17:45", workstream: "Service operations", pillars: ["customer", "process"] },
      ],
      outsideNotes: [{ note: "A new ERP is being trialled in one depot.", at: "00:31:40" }],
    },
    status: "draft",
    version: 1,
    createdByAgentId: "agent-everest",
    createdByRunId: "run-1",
    createdByUserId: null,
    decidedByUserId: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: "2026-11-12T10:00:00.000Z",
    updatedAt: "2026-11-12T10:00:00.000Z",
  },
];

function seed(queryClient: QueryClient) {
  queryClient.setQueryData(deepDiveRecordsQueryKeys.list(COMPANY_ID), {
    deepDives: RECORDS,
    clients: [
      { id: "client-a", name: "Northwind Freight (demo)", stageName: "Deep Dive", atDeepDiveStage: true },
      { id: "client-b", name: "Atlas Water (demo)", stageName: "GITA", atDeepDiveStage: false },
    ],
  });
  queryClient.setQueryData(deepDiveRecordsQueryKeys.drafts({ companyId: COMPANY_ID, recordCaseId: "record-1" }), DRAFTS);
}

function Scenario({ path }: { path: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  useState(() => {
    seed(queryClient);
    return true;
  });
  useEffect(() => {
    if (selectedCompanyId !== COMPANY_ID) setSelectedCompanyId(COMPANY_ID);
  }, [selectedCompanyId, setSelectedCompanyId]);
  const target = `/PAP${path}`;
  const onRoute = `${location.pathname}${location.search}` === target;
  useEffect(() => {
    if (!onRoute) navigate(target, { replace: true });
  }, [onRoute, navigate, target]);
  if (selectedCompanyId !== COMPANY_ID || !onRoute) return null;
  return (
    <div className="p-4 sm:p-6">
      <Routes>
        <Route path="/:companyPrefix/deep-dive" element={<DeepDiveTiles />} />
        <Route path="/:companyPrefix/deep-dive/:recordId/*" element={<DeepDivePortal />} />
      </Routes>
    </div>
  );
}

const meta: Meta = {
  title: "Pages/Deep Dive",
  parameters: { layout: "fullscreen", a11y: { test: "off" } },
};
export default meta;
type Story = StoryObj;

export const Tiles: Story = { render: () => <Scenario path="/deep-dive" /> };
export const StartADeepDive: Story = { render: () => <Scenario path="/deep-dive?start=client-a" /> };
export const QuestionsAndAnswers: Story = { render: () => <Scenario path="/deep-dive/record-1/questions" /> };

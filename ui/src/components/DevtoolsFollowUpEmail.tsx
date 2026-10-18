import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { pipelinesApi, type PipelineCaseDetail } from "../api/pipelines";
import { queryKeys } from "../lib/queryKeys";
import { formatCalendarDay } from "@/lib/utils";
import { EmailDraftDialog, type EmailDraftSeed } from "./EmailDraftDialog";
import { Button } from "./ui/button";

// A follow-up email for a Pipedrive deal, saved as a draft in one of the
// company's mailboxes. Nothing is sent: the person reviews and sends it from
// their own mail app.

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** The draft's starting text from the deal's last and next step; the person edits it before saving. */
export function dealFollowUpEmail(
  dealTitle: string,
  fields: Record<string, unknown> | null | undefined,
  contact: { name: string; email: string | null } | null,
): EmailDraftSeed {
  const record = fields ?? {};
  const first = contact?.name.trim().split(/\s+/)[0];
  const lastSubject = text(record.lastActivitySubject);
  const nextSubject = text(record.nextActivitySubject);
  const nextDate = /^\d{4}-\d{2}-\d{2}/.test(text(record.nextActivityDate)) ? text(record.nextActivityDate).slice(0, 10) : "";
  return {
    to: contact?.email ? [contact.email] : [],
    subject: `${dealTitle}: following up`,
    text: [
      first ? `Hello ${first},` : "Hello,",
      "",
      lastSubject ? `Thank you for your time on our ${lastSubject.charAt(0).toLowerCase()}${lastSubject.slice(1)}.` : "Thank you for your time recently.",
      "",
      ...(nextSubject || nextDate
        ? [`Next step: ${nextSubject || "our follow-up"}${nextDate ? ` (${formatCalendarDay(nextDate)})` : ""}.`, ""]
        : []),
      "Do let me know if you have any questions in the meantime.",
      "",
      "Kind regards,",
    ].join("\n"),
  };
}

export function DevtoolsFollowUpEmail({ detail }: { detail: PipelineCaseDetail }) {
  const [open, setOpen] = useState(false);
  const companyId = detail.case.companyId ?? null;
  const contacts = useQuery({
    queryKey: queryKeys.pipelines.caseContacts(detail.case.id),
    queryFn: () => pipelinesApi.listCaseContacts(detail.case.id),
    enabled: open,
  });
  const seed = useMemo(() => {
    const contact = (contacts.data ?? []).find((row) => row.email) ?? contacts.data?.[0] ?? null;
    return dealFollowUpEmail(detail.case.title, detail.case.fields, contact);
  }, [contacts.data, detail.case.title, detail.case.fields]);
  if (!companyId) return null;
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Draft follow-up email
      </Button>
      {open && contacts.isFetched ? (
        <EmailDraftDialog
          open
          onOpenChange={(next) => setOpen(next)}
          companyId={companyId}
          title="Follow-up email"
          seed={seed}
        />
      ) : null}
    </>
  );
}

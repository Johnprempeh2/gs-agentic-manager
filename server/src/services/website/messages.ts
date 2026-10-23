// Words the website API returns to people and agents. Text from the GRE-2107
// copy document (sections 8 and 13); keys match that document. Strings
// marked "new" are not in the copy yet and are listed on GRE-2107 for Harbor.

export const WEBSITE_MESSAGES = {
  "perm.view_none": "You do not have access to the Website section. Ask an admin of this company.",
  "perm.edit_none": "You can view this site but not edit it. Ask an admin for edit access.",
  "perm.publish_none": "You can save changes and send them for review. A person with Publish rights approves them and starts the Publish.",
  "perm.settings": "Only people with Publish rights can change site settings, the theme and the token.",
  "agent.publish_refused": "Agents cannot Publish, retry or roll back. Propose a Publish instead; a person approves it.",
  "agent.grant_refused": "Agents cannot have Publish rights. Each Publish is a person's click.",
  // new: an agent tries to approve or send back a page or entry.
  "agent.approve_refused": "Agents cannot approve changes. Send the change for review; a person with Publish rights approves it.",
  // new: Approve and Publish on a site the person has no Publish rights for.
  "proposal.publish.no_rights": "Only a person with Publish rights for this site can approve this Publish.",
  // new: propose when nothing is approved (pattern of publish.button.none.help).
  "proposal.publish.nothing": "Nothing to Publish. There are no approved changes since the last Publish. Send changes for review first.",
  // new: the server cannot start a Publish yet (2.4 not wired in).
  "proposal.publish.unavailable": "Publish is not ready on this server yet. Nothing was sent and no credits were used. The proposal stays open.",
  // new: a planned page has no content to approve.
  "review.planned": "This page is planned only. Add content and save a draft before you send it for review.",
  // new: send back a page or entry that is not in review.
  "review.not_in_review": "Only a change that is in review can be sent back.",
  "review.archived": "This is archived. Restore it before you send it for review.",
} as const;

export type WebsiteMessageKey = keyof typeof WEBSITE_MESSAGES;

/** proposal.publish.title and proposal.publish.body (with the _one form). */
export function publishProposalText(proposer: string, count: number) {
  return {
    title: `${proposer} proposes a Publish`,
    summary: count === 1
      ? "1 change is ready. Approving starts a Publish in your name. It costs about 15 credits."
      : `${count} changes are ready. Approving starts a Publish in your name. It costs about 15 credits.`,
  };
}

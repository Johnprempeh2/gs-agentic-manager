# When someone leaves

When a person leaves the company, use **Hand over and remove** on their row in
Company Settings > Members. It moves everything that depends on them to a
successor, switches off their access, and leaves the successor a task that
lists what moved and what they need to do.

Do not just suspend or archive someone who still owns work. Their routines and
agents keep naming them, and runs then stop with "The responsible user is not
an active company member".

## Who can do it

- Company owners and admins.
- Only an owner can hand over an owner or an admin.
- You cannot hand over yourself, and the company must keep at least one active
  owner who can sign in (the legacy `local-board` account does not count).
- The successor must be an active person in the company, other than the person
  leaving. The legacy `local-board` account cannot be a successor.

## The three steps

1. **Choose the successor.** Everything goes to them by default.
2. **Review.** The page lists everything that depends on the person, grouped,
   with a recommended action for each item. You can send a single item
   elsewhere: another person, an agent (for a task they were doing themselves),
   leave it unassigned, close it, or leave it as it is. Anything that would
   break is shown in red as a blocker, and you cannot go on until it is fixed.
3. **Confirm.** A summary of what will happen. Everything is applied in one go.

Afterwards the page shows the result and links to the handover task.

## What is moved

| What | Where it goes |
| --- | --- |
| Open tasks where they are the assignee, responsible person, current reviewer, return assignee or a review step | The successor (or your choice per task). A private chat between them and an agent is closed by default. |
| Pending questions, requests and approvals addressed to them | The successor |
| Routines they are responsible for, including the latest revision and runs already fired whose task is still open | The successor. Leaving an active routine as it is is a blocker. |
| The company default responsible person, if it is them | The successor, or cleared |
| Queued agent runs on their behalf (and the run a queued retry repeats) | The successor. Runs already in progress finish on their current account. |

## Agents and AI accounts

An agent in `responsible_user` mode runs on the default AI account of whoever
is responsible for the work. When their work moves, the page checks that the
new responsible person has a usable default account for that agent:

- If they do, nothing changes on the agent.
- If they do not, but a shared company account works for the agent, the agent
  is pointed at that shared account.
- If neither works, the agent is a blocker. Ask the successor to connect an
  account in Apps and make it their default, or connect a shared account, then
  try again. An agent is never silently left with no AI account.

An agent bound directly to the person's own account (an older explicit
personal selection) is moved to the responsible person's default, or to a
shared account. With an install-wide AI access route, the route already picks
the responsible person's default or a shared account, so the page only checks
that one works.

## What is switched off

| What | What happens |
| --- | --- |
| Personal AI accounts, GitHub identity grants and tool or channel connections they own | Revoked. Personal credentials cannot be handed over, so the handover task lists what the successor must reconnect. Agent delegations from those grants go too. |
| Their place in the audience of shared connections | Removed |
| Memory rights and other permissions | Removed |
| Membership | Archived. Owners, admins and `local-board` are suspended instead, so their role stays on record. |
| Instance admin role | Kept unless an owner ticks "Also remove their instance admin role". Until then a person who is an instance admin is a blocker, because company access alone would not stop them. The last instance admin cannot be removed. `local-board` without a sign-in account keeps the role, as nothing can act as it. |
| Board API keys | Revoked, unless they still belong to another company (keys cover the whole install). |
| Sign-in sessions | Ended everywhere on the install |

Comments, approvals, activity and finished work they authored stay as they are.

## The handover task

A task called "Handover from <name>" is created for the successor, assigned to
them, with links to every moved task, routine and agent, the accounts they must
reconnect, and anything that needs a decision (items left as they were, closed
items and warnings).

## Restoring someone

Removed people are listed under "Removed people" (archived) or stay in the
member list as suspended. **Restore** makes the membership active again, gives
back the permissions the handover removed and the instance admin role if the
handover removed it. It does not move work back, and it does not restore
memory rights (only the owner memory route sets those), revoked connections,
keys or sessions: the person signs in again and reconnects their own accounts.

## The legacy local-board account

After switching from `local_trusted` to `authenticated` mode, the old
`local-board` account uses the same flow. Its successor defaults to the
company's primary owner. In `local_trusted` mode it is the board itself and is
refused.

## API

- `POST /api/companies/:companyId/members/:memberId/handover` with
  `{ successorUserId, overrides?: [{ itemRef, toUserId | toAgentId | action, sharedGrantId? }], dryRun, removeInstanceAdmin? }`.
  `action` is one of `leave`, `unassign`, `close`, `clear`,
  `use_personal_default` or `use_shared_connection` (with `sharedGrantId`).
  A dry run returns the plan and writes nothing. A blocked execute answers 422
  with `details.blockers`.
- `POST /api/companies/:companyId/members/:memberId/restore` with `{}`.

Every handover is logged as `company_member.handed_over` with full counts, and
every restore as `company_member.restored`.

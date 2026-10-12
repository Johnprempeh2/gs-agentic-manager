/**
 * Row lock for a heavily referenced parent row: a heartbeat run, a task, or a
 * comment that files are attached to.
 *
 * Every insert of a row with a foreign key takes FOR KEY SHARE on the parent
 * row it references, and FOR UPDATE is the only row lock that conflicts with
 * FOR KEY SHARE. A transaction holding FOR UPDATE on a run or a task therefore
 * waits for, and then blocks, every concurrent write that references it: run
 * events, comments, document revisions, audit rows. When that writer has
 * referenced the run and next touches the task (or the reverse), the two
 * transactions deadlock (live, 2 to 3 Oct 2026; see run-identity.ts).
 *
 * FOR NO KEY UPDATE still conflicts with every other explicit row lock (FOR
 * SHARE, FOR NO KEY UPDATE, FOR UPDATE) and with every UPDATE and DELETE of the
 * row, so it serialises the row's writers and lockers exactly as FOR UPDATE
 * does. It only stops blocking inserts that reference the row; those neither
 * read nor change it, and FOR UPDATE would only have delayed them.
 *
 * Use it unless the transaction deletes the row or changes a column covered by
 * a unique index: `id` and `company_id`; for runs also `native_issue_id` and
 * `completion_contract_id`; for tasks also `identifier` and the conversation
 * agent and user; for comments also `issue_id`, `author_user_id` and
 * `client_request_id`. Those writes need FOR UPDATE.
 *
 * Within one transaction, lock a given row this way everywhere or not at all.
 * A later FOR UPDATE on a row already held FOR NO KEY UPDATE upgrades the lock
 * mid-transaction and brings the conflict back, now with more locks held.
 */
export const REFERENCED_ROW_LOCK = "no key update" as const;

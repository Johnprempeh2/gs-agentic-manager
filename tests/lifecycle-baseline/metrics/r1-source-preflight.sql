-- John-operated, read-only inventory only, after separate GRE-3269 approval.
-- Run with psql -X -v ON_ERROR_STOP=1 -v company_id=34dad57e-b5ad-4a72-9400-9eba645c99f6 -f <absolute path>.
-- Output contains only source metadata and aggregate counts/timestamps; do not share credentials or raw rows.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

SELECT transaction_timestamp() AS inventory_at, current_user AS role,
       current_database() AS database, inet_server_port() AS port,
       current_setting('transaction_read_only') AS read_only,
       current_setting('transaction_isolation') AS isolation;

SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
FROM pg_roles WHERE rolname = current_user;

WITH names(name) AS (VALUES
  ('issues'), ('activity_log'), ('heartbeat_runs'), ('agent_wakeup_requests'),
  ('issue_thread_interactions'), ('issue_approvals'), ('approvals'),
  ('issue_recovery_actions'), ('issue_tree_holds'), ('issue_relations'), ('agents'))
SELECT count(*) AS required_tables,
       count(*) FILTER (WHERE has_table_privilege(current_user, name, 'SELECT')) AS selectable_tables,
       count(*) FILTER (WHERE has_table_privilege(current_user, name, 'INSERT')
         OR has_table_privilege(current_user, name, 'UPDATE')
         OR has_table_privilege(current_user, name, 'DELETE')
         OR has_table_privilege(current_user, name, 'TRUNCATE')) AS writable_tables
FROM names;

SELECT count(*) AS current_company_issues FROM issues WHERE company_id = :'company_id';

SELECT count(*) AS seven_day_activity_rows, min(created_at) AS oldest_retained_activity,
       max(created_at) AS newest_retained_activity
FROM activity_log WHERE company_id = :'company_id'
  AND created_at >= transaction_timestamp() - interval '7 days';

SELECT count(*) AS all_linked_runs,
       count(*) FILTER (WHERE r.created_at < transaction_timestamp() - interval '7 days') AS older_linked_runs,
       min(r.created_at) AS oldest_linked_run,
       max(r.created_at) AS newest_linked_run
FROM heartbeat_runs r WHERE r.company_id = :'company_id'
  AND EXISTS (SELECT 1 FROM issues i WHERE i.company_id = :'company_id'
    AND i.id::text IN (r.context_snapshot->>'issueId', r.context_snapshot->>'taskId', r.native_issue_id::text));

COMMIT;

-- John-operated, read-only inventory only, after separate GRE-3269 approval.
-- Run with psql -X -v ON_ERROR_STOP=1 -v company_id=34dad57e-b5ad-4a72-9400-9eba645c99f6 -f <absolute path>.
-- Output contains only source metadata and aggregate counts/timestamps; do not share credentials or raw rows.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

-- Abort before inventory if any manifest field or read-only control is missing.
-- The paired synthetic test checks this list against R1_TABLE_COLUMNS.
DO $preflight$
DECLARE missing text;
BEGIN
  WITH required(table_name, column_name) AS (VALUES
    ('issues','id'), ('issues','company_id'), ('issues','identifier'), ('issues','parent_id'), ('issues','status'), ('issues','assignee_agent_id'), ('issues','assignee_user_id'), ('issues','conversation_user_id'), ('issues','conversation_state'), ('issues','monitor_next_check_at'), ('issues','monitor_wake_requested_at'), ('issues','hidden_at'), ('issues','updated_at'), ('issues','tabled_by_user_id'),
    ('activity_log','company_id'), ('activity_log','entity_type'), ('activity_log','entity_id'), ('activity_log','actor_type'), ('activity_log','action'), ('activity_log','details'), ('activity_log','created_at'),
    ('heartbeat_runs','company_id'), ('heartbeat_runs','id'), ('heartbeat_runs','status'), ('heartbeat_runs','context_snapshot'), ('heartbeat_runs','native_issue_id'), ('heartbeat_runs','created_at'), ('heartbeat_runs','started_at'), ('heartbeat_runs','last_output_at'), ('heartbeat_runs','finished_at'),
    ('agent_wakeup_requests','company_id'), ('agent_wakeup_requests','status'), ('agent_wakeup_requests','payload'),
    ('issue_thread_interactions','company_id'), ('issue_thread_interactions','issue_id'), ('issue_thread_interactions','status'),
    ('issue_approvals','company_id'), ('issue_approvals','issue_id'), ('issue_approvals','approval_id'),
    ('approvals','id'), ('approvals','company_id'), ('approvals','status'),
    ('issue_recovery_actions','company_id'), ('issue_recovery_actions','source_issue_id'), ('issue_recovery_actions','resolved_at'), ('issue_recovery_actions','status'), ('issue_recovery_actions','cause'), ('issue_recovery_actions','evidence'),
    ('issue_tree_holds','company_id'), ('issue_tree_holds','root_issue_id'), ('issue_tree_holds','status'),
    ('issue_relations','company_id'), ('issue_relations','issue_id'), ('issue_relations','related_issue_id'), ('issue_relations','type'),
    ('agents','company_id'), ('agents','id'), ('agents','status'), ('agents','runtime_config'))
  SELECT string_agg(format('%I.%I', r.table_name, r.column_name), ', ')
  INTO missing FROM required r
  LEFT JOIN information_schema.columns c ON c.table_schema = 'public'
    AND c.table_name = r.table_name AND c.column_name = r.column_name
  WHERE c.column_name IS NULL OR NOT has_column_privilege(current_user,
    format('public.%I', r.table_name), r.column_name, 'SELECT');
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'R1 missing readable manifest columns: %', missing; END IF;

  IF current_setting('transaction_read_only') <> 'on'
    OR current_setting('transaction_isolation') <> 'repeatable read'
    OR current_setting('default_transaction_read_only') <> 'on' THEN
    RAISE EXCEPTION 'R1 requires read-only transaction, isolation and session default';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole
    WHERE r.rolname = current_user AND s.setdatabase IN (0,
      (SELECT oid FROM pg_database WHERE datname = current_database()))
      AND 'default_transaction_read_only=on' = ANY(s.setconfig)) THEN
    RAISE EXCEPTION 'R1 role has no stored read-only default';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user
    AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'R1 role has elevated attributes';
  END IF;
  IF has_database_privilege(current_user, current_database(), 'CREATE')
    OR has_database_privilege(current_user, current_database(), 'TEMP')
    OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%'
      AND n.nspname <> 'information_schema' AND has_schema_privilege(current_user, n.oid, 'CREATE'))
    OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
      AND c.relkind IN ('r','p','v','m','f')
      AND (has_table_privilege(current_user,c.oid,'INSERT') OR has_table_privilege(current_user,c.oid,'UPDATE')
        OR has_table_privilege(current_user,c.oid,'DELETE') OR has_table_privilege(current_user,c.oid,'TRUNCATE')))
    OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind = 'S'
      AND (has_sequence_privilege(current_user,c.oid,'USAGE') OR has_sequence_privilege(current_user,c.oid,'UPDATE')))
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
      AND p.prosecdef AND has_function_privilege(current_user,p.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'R1 role has an effective write capability outside the manifest';
  END IF;
END
$preflight$;

SELECT transaction_timestamp() AS inventory_at, current_user AS role,
       current_database() AS database, inet_server_port() AS port,
       current_setting('transaction_read_only') AS read_only,
       current_setting('transaction_isolation') AS isolation;

SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
FROM pg_roles WHERE rolname = current_user;

WITH names(name) AS (VALUES
  ('public.issues'), ('public.activity_log'), ('public.heartbeat_runs'), ('public.agent_wakeup_requests'),
  ('public.issue_thread_interactions'), ('public.issue_approvals'), ('public.approvals'),
  ('public.issue_recovery_actions'), ('public.issue_tree_holds'), ('public.issue_relations'), ('public.agents'))
SELECT count(*) AS required_tables,
       count(*) FILTER (WHERE has_table_privilege(current_user, name, 'SELECT')) AS selectable_tables,
       count(*) FILTER (WHERE has_table_privilege(current_user, name, 'INSERT')
         OR has_table_privilege(current_user, name, 'UPDATE')
         OR has_table_privilege(current_user, name, 'DELETE')
         OR has_table_privilege(current_user, name, 'TRUNCATE')) AS writable_tables
FROM names;

SELECT count(*) AS current_company_issues FROM public.issues WHERE company_id = :'company_id';

SELECT count(*) AS seven_day_activity_rows, min(created_at) AS oldest_retained_activity,
       max(created_at) AS newest_retained_activity
FROM public.activity_log WHERE company_id = :'company_id'
  AND created_at >= transaction_timestamp() - interval '7 days';

SELECT count(*) AS all_linked_runs,
       count(*) FILTER (WHERE r.created_at < transaction_timestamp() - interval '7 days') AS older_linked_runs,
       min(r.created_at) AS oldest_linked_run,
       max(r.created_at) AS newest_linked_run
FROM public.heartbeat_runs r WHERE r.company_id = :'company_id'
  AND EXISTS (SELECT 1 FROM public.issues i WHERE i.company_id = :'company_id'
    AND i.id::text IN (r.context_snapshot->>'issueId', r.context_snapshot->>'taskId', r.native_issue_id::text));

COMMIT;

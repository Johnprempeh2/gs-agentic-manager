-- PROPOSED LIVE WRITE. Not part of read-only inventory approval.
-- John runs this once, as the database owner, only after a separate John decision on GRE-3269.
-- No agent runs this file or holds the owner credential.
-- psql -h 127.0.0.1 -p <verified port> -U <owner> -d paperclip -X -v ON_ERROR_STOP=1 \
--   -v r1_password="<new password>" -f r1-reader-role.sql
-- The password is then stored only as the company secret `r1-reader-password`, granted to Everest.
\set ON_ERROR_STOP on
BEGIN;
CREATE ROLE gsam_r1_reader LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'r1_password';
ALTER ROLE gsam_r1_reader IN DATABASE paperclip SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE paperclip TO gsam_r1_reader;
GRANT USAGE ON SCHEMA public TO gsam_r1_reader;
GRANT SELECT ON
  public.issues, public.activity_log, public.heartbeat_runs, public.agent_wakeup_requests,
  public.issue_thread_interactions, public.issue_approvals, public.approvals,
  public.issue_recovery_actions, public.issue_tree_holds, public.issue_relations, public.agents
  TO gsam_r1_reader;
-- The preflight rejects TEMP. PUBLIC holds TEMP on new databases by default; check before commit.
SELECT has_database_privilege('gsam_r1_reader', 'paperclip', 'TEMP') AS r1_reader_has_temp;
COMMIT;
-- Removal at the deletion deadline: DROP OWNED BY gsam_r1_reader; DROP ROLE gsam_r1_reader;

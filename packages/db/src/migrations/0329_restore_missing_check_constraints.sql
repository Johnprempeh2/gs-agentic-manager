-- Restore named CHECK constraints lost in a backup restore (GRE-1422).
-- Live was restored from a JavaScript backup taken before GRE-1058, when the backup engine
-- did not export CHECK constraints. The 2026-10-12 live copy has 23 of the 111 named checks in
-- the schema. A later migration that drops one of the missing checks without IF EXISTS fails
-- with 42704 (as 0325 did, GRE-1420), and live does not enforce the missing rules.
-- Each check is added only when the table does not already have a constraint with that name,
-- so fresh installs keep their validated checks and a replay is a no-op. Expressions are the
-- Drizzle schema's, as in the 0328 snapshot (113 checks: the 111 above plus the two that 0328
-- creates with client_support_tickets, which are always present here).
-- NOT VALID: new and updated rows are checked; existing rows are not. VALIDATE CONSTRAINT
-- goes in a later migration after rows that break a rule are cleaned up.
-- Rollback: ALTER TABLE ... DROP CONSTRAINT IF EXISTS for each check this migration added (not
-- advised: fresh installs have all of them).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."ai_connection_defaults"'::regclass AND conname = 'ai_connection_defaults_method_check'
  ) THEN
    ALTER TABLE "public"."ai_connection_defaults" ADD CONSTRAINT "ai_connection_defaults_method_check" CHECK ("ai_connection_defaults"."method" in ('subscription','api_key')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."ai_connection_defaults"'::regclass AND conname = 'ai_connection_defaults_provider_check'
  ) THEN
    ALTER TABLE "public"."ai_connection_defaults" ADD CONSTRAINT "ai_connection_defaults_provider_check" CHECK ("ai_connection_defaults"."provider" in ('anthropic','openai','openrouter','xai')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."ai_provider_defaults"'::regclass AND conname = 'ai_provider_defaults_provider_check'
  ) THEN
    ALTER TABLE "public"."ai_provider_defaults" ADD CONSTRAINT "ai_provider_defaults_provider_check" CHECK ("ai_provider_defaults"."provider" in ('anthropic','openai','openrouter','xai')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."case_events"'::regclass AND conname = 'case_events_actor_type_check'
  ) THEN
    ALTER TABLE "public"."case_events" ADD CONSTRAINT "case_events_actor_type_check" CHECK ("case_events"."actor_type" in ('user', 'agent', 'system')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."case_events"'::regclass AND conname = 'case_events_kind_check'
  ) THEN
    ALTER TABLE "public"."case_events" ADD CONSTRAINT "case_events_kind_check" CHECK ("case_events"."kind" in (
        'created',
        'updated',
        'fields_changed',
        'status_changed',
        'issue_linked',
        'issue_unlinked',
        'document_revised',
        'child_linked',
        'attachment_added',
        'label_added',
        'label_removed'
      )) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."case_issue_links"'::regclass AND conname = 'case_issue_links_role_check'
  ) THEN
    ALTER TABLE "public"."case_issue_links" ADD CONSTRAINT "case_issue_links_role_check" CHECK ("case_issue_links"."role" in ('origin', 'work', 'reference')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."cases"'::regclass AND conname = 'cases_status_check'
  ) THEN
    ALTER TABLE "public"."cases" ADD CONSTRAINT "cases_status_check" CHECK ("cases"."status" in ('draft', 'in_progress', 'in_review', 'approved', 'done', 'cancelled')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_agent_routes"'::regclass AND conname = 'chat_agent_routes_hops_check'
  ) THEN
    ALTER TABLE "public"."chat_agent_routes" ADD CONSTRAINT "chat_agent_routes_hops_check" CHECK ("chat_agent_routes"."max_hops" between 1 and 8) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_conversations"'::regclass AND conname = 'chat_conversations_state_check'
  ) THEN
    ALTER TABLE "public"."chat_conversations" ADD CONSTRAINT "chat_conversations_state_check" CHECK ("chat_conversations"."state" in ('active', 'waiting', 'completed', 'unavailable', 'endpoint_removed')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_deliveries"'::regclass AND conname = 'chat_deliveries_state_check'
  ) THEN
    ALTER TABLE "public"."chat_deliveries" ADD CONSTRAINT "chat_deliveries_state_check" CHECK ("chat_deliveries"."state" in ('received', 'filtered', 'processing', 'processed', 'retry', 'failed')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_discord_command_owners"'::regclass AND conname = 'chat_discord_command_owners_application_check'
  ) THEN
    ALTER TABLE "public"."chat_discord_command_owners" ADD CONSTRAINT "chat_discord_command_owners_application_check" CHECK ("chat_discord_command_owners"."application_id" ~ '^[1-9][0-9]{16,19}$') NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_endpoint_resources"'::regclass AND conname = 'chat_endpoint_resources_availability_check'
  ) THEN
    ALTER TABLE "public"."chat_endpoint_resources" ADD CONSTRAINT "chat_endpoint_resources_availability_check" CHECK ("chat_endpoint_resources"."availability" in ('available', 'unavailable', 'removed')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_endpoints"'::regclass AND conname = 'chat_endpoints_concurrency_check'
  ) THEN
    ALTER TABLE "public"."chat_endpoints" ADD CONSTRAINT "chat_endpoints_concurrency_check" CHECK ("chat_endpoints"."concurrency_policy" in ('burst', 'queue', 'debounce', 'drop', 'concurrent')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_endpoints"'::regclass AND conname = 'chat_endpoints_deployment_check'
  ) THEN
    ALTER TABLE "public"."chat_endpoints" ADD CONSTRAINT "chat_endpoints_deployment_check" CHECK ("chat_endpoints"."deployment_mode" in ('direct', 'relay')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_endpoints"'::regclass AND conname = 'chat_endpoints_email_policy_check'
  ) THEN
    ALTER TABLE "public"."chat_endpoints" ADD CONSTRAINT "chat_endpoints_email_policy_check" CHECK ("chat_endpoints"."provider" <> 'agentmail' or ("chat_endpoints"."publication_mode" = 'explicit' and "chat_endpoints"."external_execution_policy" = 'agent')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_endpoints"'::regclass AND conname = 'chat_endpoints_execution_policy_check'
  ) THEN
    ALTER TABLE "public"."chat_endpoints" ADD CONSTRAINT "chat_endpoints_execution_policy_check" CHECK ("chat_endpoints"."external_execution_policy" in ('restricted', 'agent')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_endpoints"'::regclass AND conname = 'chat_endpoints_provider_check'
  ) THEN
    ALTER TABLE "public"."chat_endpoints" ADD CONSTRAINT "chat_endpoints_provider_check" CHECK ("chat_endpoints"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'agentmail', 'imessage-photon')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_endpoints"'::regclass AND conname = 'chat_endpoints_publication_mode_check'
  ) THEN
    ALTER TABLE "public"."chat_endpoints" ADD CONSTRAINT "chat_endpoints_publication_mode_check" CHECK ("chat_endpoints"."publication_mode" in ('automatic', 'explicit')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_endpoints"'::regclass AND conname = 'chat_endpoints_status_check'
  ) THEN
    ALTER TABLE "public"."chat_endpoints" ADD CONSTRAINT "chat_endpoints_status_check" CHECK ("chat_endpoints"."status" in ('draft', 'verifying', 'active', 'paused', 'attention', 'revoked', 'archived')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_external_principals"'::regclass AND conname = 'chat_external_principals_kind_check'
  ) THEN
    ALTER TABLE "public"."chat_external_principals" ADD CONSTRAINT "chat_external_principals_kind_check" CHECK ("chat_external_principals"."kind" in ('user', 'bot', 'app', 'system')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_external_principals"'::regclass AND conname = 'chat_external_principals_provider_check'
  ) THEN
    ALTER TABLE "public"."chat_external_principals" ADD CONSTRAINT "chat_external_principals_provider_check" CHECK ("chat_external_principals"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'agentmail', 'imessage-photon')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_github_configurations"'::regclass AND conname = 'chat_github_config_revision_check'
  ) THEN
    ALTER TABLE "public"."chat_github_configurations" ADD CONSTRAINT "chat_github_config_revision_check" CHECK ("chat_github_configurations"."revision" > 0) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_github_registrations"'::regclass AND conname = 'chat_github_registration_status_check'
  ) THEN
    ALTER TABLE "public"."chat_github_registrations" ADD CONSTRAINT "chat_github_registration_status_check" CHECK ("chat_github_registrations"."status" in ('pending', 'exchanging', 'completed', 'failed')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_github_reviews"'::regclass AND conname = 'chat_github_review_pull_number_check'
  ) THEN
    ALTER TABLE "public"."chat_github_reviews" ADD CONSTRAINT "chat_github_review_pull_number_check" CHECK ("chat_github_reviews"."pull_number" > 0) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_github_reviews"'::regclass AND conname = 'chat_github_review_state_check'
  ) THEN
    ALTER TABLE "public"."chat_github_reviews" ADD CONSTRAINT "chat_github_review_state_check" CHECK ("chat_github_reviews"."state" in ('queued', 'running', 'completed', 'incomplete', 'error', 'superseded', 'manual_required')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_identity_links"'::regclass AND conname = 'chat_identity_links_status_check'
  ) THEN
    ALTER TABLE "public"."chat_identity_links" ADD CONSTRAINT "chat_identity_links_status_check" CHECK ("chat_identity_links"."status" in ('pending', 'linked', 'revoked', 'expired')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_message_links"'::regclass AND conname = 'chat_message_links_direction_check'
  ) THEN
    ALTER TABLE "public"."chat_message_links" ADD CONSTRAINT "chat_message_links_direction_check" CHECK ("chat_message_links"."direction" in ('inbound', 'outbound')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_publications"'::regclass AND conname = 'chat_publications_state_check'
  ) THEN
    ALTER TABLE "public"."chat_publications" ADD CONSTRAINT "chat_publications_state_check" CHECK ("chat_publications"."state" in ('pending', 'streaming', 'published', 'retry', 'delivery_unknown', 'failed', 'cancelled', 'awaiting_consent')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_teams_file_transfers"'::regclass AND conname = 'chat_teams_file_transfers_attempt_check'
  ) THEN
    ALTER TABLE "public"."chat_teams_file_transfers" ADD CONSTRAINT "chat_teams_file_transfers_attempt_check" CHECK (("chat_teams_file_transfers"."attempt_id" is null) = ("chat_teams_file_transfers"."attempt_expires_at" is null)) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_teams_file_transfers"'::regclass AND conname = 'chat_teams_file_transfers_bounds_check'
  ) THEN
    ALTER TABLE "public"."chat_teams_file_transfers" ADD CONSTRAINT "chat_teams_file_transfers_bounds_check" CHECK ("chat_teams_file_transfers"."version" > 0 and "chat_teams_file_transfers"."runtime_generation" >= 0 and "chat_teams_file_transfers"."conversation_generation" > 0 and "chat_teams_file_transfers"."byte_size" > 0 and "chat_teams_file_transfers"."byte_size" < 62914560) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_teams_file_transfers"'::regclass AND conname = 'chat_teams_file_transfers_hash_check'
  ) THEN
    ALTER TABLE "public"."chat_teams_file_transfers" ADD CONSTRAINT "chat_teams_file_transfers_hash_check" CHECK ("chat_teams_file_transfers"."source_digest" ~ '^[a-f0-9]{64}$' and "chat_teams_file_transfers"."authority_digest" ~ '^[a-f0-9]{64}$' and "chat_teams_file_transfers"."sha256" ~ '^[a-f0-9]{64}$' and "chat_teams_file_transfers"."token_sha256" ~ '^[a-f0-9]{64}$') NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."chat_teams_file_transfers"'::regclass AND conname = 'chat_teams_file_transfers_phase_check'
  ) THEN
    ALTER TABLE "public"."chat_teams_file_transfers" ADD CONSTRAINT "chat_teams_file_transfers_phase_check" CHECK ("chat_teams_file_transfers"."phase" in ('consent_pending','consent_sending','consent_unknown','awaiting_consent','upload_pending','uploading','upload_unknown','file_info_pending','file_info_sending','file_info_unknown','delivered','declined','expired','cancelled','conflict')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."client_support_tickets"'::regclass AND conname = 'client_support_tickets_kind_check'
  ) THEN
    ALTER TABLE "public"."client_support_tickets" ADD CONSTRAINT "client_support_tickets_kind_check" CHECK ("client_support_tickets"."kind" in ('support', 'quality-review', 'upgrade')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."client_support_tickets"'::regclass AND conname = 'client_support_tickets_priority_check'
  ) THEN
    ALTER TABLE "public"."client_support_tickets" ADD CONSTRAINT "client_support_tickets_priority_check" CHECK ("client_support_tickets"."priority" in ('P1', 'P2', 'P3')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."company_secret_proposals"'::regclass AND conname = 'company_secret_proposals_kind_check'
  ) THEN
    ALTER TABLE "public"."company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_kind_check" CHECK ("company_secret_proposals"."kind" in ('secret', 'binding')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."company_secret_proposals"'::regclass AND conname = 'company_secret_proposals_projection_check'
  ) THEN
    ALTER TABLE "public"."company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_projection_check" CHECK ("company_secret_proposals"."projection_class" = 'unclassified') NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."company_secret_proposals"'::regclass AND conname = 'company_secret_proposals_shape_check'
  ) THEN
    ALTER TABLE "public"."company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_shape_check" CHECK ((
      "company_secret_proposals"."kind" = 'secret'
      and "company_secret_proposals"."proposed_name" is not null
      and "company_secret_proposals"."proposed_key" is not null
      and "company_secret_proposals"."secret_id" is null
      and "company_secret_proposals"."secret_proposal_id" is null
      and "company_secret_proposals"."target_type" is null
      and "company_secret_proposals"."target_id" is null
      and "company_secret_proposals"."config_path" is null
    ) or (
      "company_secret_proposals"."kind" = 'binding'
      and (("company_secret_proposals"."secret_id" is not null)::int + ("company_secret_proposals"."secret_proposal_id" is not null)::int) = 1
      and "company_secret_proposals"."target_type" = 'agent'
      and "company_secret_proposals"."target_id" is not null
      and "company_secret_proposals"."config_path" is not null
    )) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."company_secret_proposals"'::regclass AND conname = 'company_secret_proposals_status_check'
  ) THEN
    ALTER TABLE "public"."company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_status_check" CHECK ("company_secret_proposals"."status" in ('pending', 'approved', 'rejected', 'withdrawn', 'expired')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."company_secrets"'::regclass AND conname = 'company_secrets_scope_shape_check'
  ) THEN
    ALTER TABLE "public"."company_secrets" ADD CONSTRAINT "company_secrets_scope_shape_check" CHECK ((
        "company_secrets"."scope" = 'company'
        and "company_secrets"."owner_user_id" is null
        and "company_secrets"."user_secret_definition_id" is null
      ) or (
        "company_secrets"."scope" = 'user'
        and "company_secrets"."owner_user_id" is not null
        and "company_secrets"."user_secret_definition_id" is not null
      )) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."connection_grant_members"'::regclass AND conname = 'connection_grant_members_subject_type_check'
  ) THEN
    ALTER TABLE "public"."connection_grant_members" ADD CONSTRAINT "connection_grant_members_subject_type_check" CHECK ("connection_grant_members"."subject_type" in ('user')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."connection_grants"'::regclass AND conname = 'connection_grants_credential_source_one_of_check'
  ) THEN
    ALTER TABLE "public"."connection_grants" ADD CONSTRAINT "connection_grants_credential_source_one_of_check" CHECK ("connection_grants"."external_credential" is null or jsonb_array_length("connection_grants"."credential_secret_refs") = 0) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."connection_grants"'::regclass AND conname = 'connection_grants_default_check'
  ) THEN
    ALTER TABLE "public"."connection_grants" ADD CONSTRAINT "connection_grants_default_check" CHECK ("connection_grants"."is_default" = false or "connection_grants"."kind" = 'organization') NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."connection_grants"'::regclass AND conname = 'connection_grants_kind_check'
  ) THEN
    ALTER TABLE "public"."connection_grants" ADD CONSTRAINT "connection_grants_kind_check" CHECK ("connection_grants"."kind" in ('organization', 'user', 'agent')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."connection_grants"'::regclass AND conname = 'connection_grants_status_check'
  ) THEN
    ALTER TABLE "public"."connection_grants" ADD CONSTRAINT "connection_grants_status_check" CHECK ("connection_grants"."status" in ('active', 'revoked', 'expired', 'needs_reauthorization', 'suspended')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."connection_grants"'::regclass AND conname = 'connection_grants_subject_check'
  ) THEN
    ALTER TABLE "public"."connection_grants" ADD CONSTRAINT "connection_grants_subject_check" CHECK (("connection_grants"."kind" = 'user' and "connection_grants"."subject_user_id" is not null and "connection_grants"."subject_agent_id" is null) or ("connection_grants"."kind" = 'agent' and "connection_grants"."subject_agent_id" is not null and "connection_grants"."subject_user_id" is null) or ("connection_grants"."kind" = 'organization' and "connection_grants"."subject_user_id" is null and "connection_grants"."subject_agent_id" is null)) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."crm_sync_bindings"'::regclass AND conname = 'crm_sync_bindings_container_kind_check'
  ) THEN
    ALTER TABLE "public"."crm_sync_bindings" ADD CONSTRAINT "crm_sync_bindings_container_kind_check" CHECK ("crm_sync_bindings"."container_kind" in ('crm_pipeline', 'notion_database')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."crm_sync_bindings"'::regclass AND conname = 'crm_sync_bindings_direction_check'
  ) THEN
    ALTER TABLE "public"."crm_sync_bindings" ADD CONSTRAINT "crm_sync_bindings_direction_check" CHECK ("crm_sync_bindings"."direction" in ('both', 'inbound_only', 'outbound_only')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."crm_sync_bindings"'::regclass AND conname = 'crm_sync_bindings_status_check'
  ) THEN
    ALTER TABLE "public"."crm_sync_bindings" ADD CONSTRAINT "crm_sync_bindings_status_check" CHECK ("crm_sync_bindings"."status" in ('active', 'paused', 'error')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."crm_sync_conflicts"'::regclass AND conname = 'crm_sync_conflicts_entity_kind_check'
  ) THEN
    ALTER TABLE "public"."crm_sync_conflicts" ADD CONSTRAINT "crm_sync_conflicts_entity_kind_check" CHECK ("crm_sync_conflicts"."entity_kind" in ('case', 'contact')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."crm_sync_conflicts"'::regclass AND conname = 'crm_sync_conflicts_kind_check'
  ) THEN
    ALTER TABLE "public"."crm_sync_conflicts" ADD CONSTRAINT "crm_sync_conflicts_kind_check" CHECK ("crm_sync_conflicts"."kind" in ('conflict', 'suggestion')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."crm_sync_conflicts"'::regclass AND conname = 'crm_sync_conflicts_proposed_resolution_check'
  ) THEN
    ALTER TABLE "public"."crm_sync_conflicts" ADD CONSTRAINT "crm_sync_conflicts_proposed_resolution_check" CHECK ("crm_sync_conflicts"."proposed_resolution" is null or "crm_sync_conflicts"."proposed_resolution" in ('keep_crm', 'keep_gsam', 'custom')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."crm_sync_conflicts"'::regclass AND conname = 'crm_sync_conflicts_resolution_check'
  ) THEN
    ALTER TABLE "public"."crm_sync_conflicts" ADD CONSTRAINT "crm_sync_conflicts_resolution_check" CHECK ("crm_sync_conflicts"."resolution" is null or "crm_sync_conflicts"."resolution" in ('keep_crm', 'keep_gsam', 'custom')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."crm_sync_conflicts"'::regclass AND conname = 'crm_sync_conflicts_status_check'
  ) THEN
    ALTER TABLE "public"."crm_sync_conflicts" ADD CONSTRAINT "crm_sync_conflicts_status_check" CHECK ("crm_sync_conflicts"."status" in ('open', 'resolved', 'dismissed')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."crm_sync_events"'::regclass AND conname = 'crm_sync_events_action_check'
  ) THEN
    ALTER TABLE "public"."crm_sync_events" ADD CONSTRAINT "crm_sync_events_action_check" CHECK ("crm_sync_events"."action" in ('created', 'updated', 'unchanged', 'conflict', 'failed')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."crm_sync_events"'::regclass AND conname = 'crm_sync_events_direction_check'
  ) THEN
    ALTER TABLE "public"."crm_sync_events" ADD CONSTRAINT "crm_sync_events_direction_check" CHECK ("crm_sync_events"."direction" in ('inbound', 'outbound')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."crm_sync_events"'::regclass AND conname = 'crm_sync_events_entity_kind_check'
  ) THEN
    ALTER TABLE "public"."crm_sync_events" ADD CONSTRAINT "crm_sync_events_entity_kind_check" CHECK ("crm_sync_events"."entity_kind" in ('case', 'contact')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."crm_sync_field_maps"'::regclass AND conname = 'crm_sync_field_maps_owner_check'
  ) THEN
    ALTER TABLE "public"."crm_sync_field_maps" ADD CONSTRAINT "crm_sync_field_maps_owner_check" CHECK ("crm_sync_field_maps"."owner" in ('crm', 'gsam', 'shared')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."crm_sync_record_links"'::regclass AND conname = 'crm_sync_record_links_entity_kind_check'
  ) THEN
    ALTER TABLE "public"."crm_sync_record_links" ADD CONSTRAINT "crm_sync_record_links_entity_kind_check" CHECK ("crm_sync_record_links"."entity_kind" in ('case', 'contact')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."decision_archive_notification_outbox"'::regclass AND conname = 'decision_archive_notification_outbox_status_check'
  ) THEN
    ALTER TABLE "public"."decision_archive_notification_outbox" ADD CONSTRAINT "decision_archive_notification_outbox_status_check" CHECK ("decision_archive_notification_outbox"."status" IN ('pending', 'delivering', 'delivered')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."decision_queue_items"'::regclass AND conname = 'decision_queue_items_actor_check'
  ) THEN
    ALTER TABLE "public"."decision_queue_items" ADD CONSTRAINT "decision_queue_items_actor_check" CHECK ((
        ("decision_queue_items"."added_by_type" = 'agent' AND "decision_queue_items"."added_by_agent_id" IS NOT NULL AND "decision_queue_items"."added_by_user_id" IS NULL)
        OR ("decision_queue_items"."added_by_type" = 'user' AND "decision_queue_items"."added_by_agent_id" IS NULL AND "decision_queue_items"."added_by_user_id" IS NOT NULL)
        OR ("decision_queue_items"."added_by_type" = 'system' AND "decision_queue_items"."added_by_agent_id" IS NULL AND "decision_queue_items"."added_by_user_id" IS NULL)
      )) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."decision_queues"'::regclass AND conname = 'decision_queues_creator_check'
  ) THEN
    ALTER TABLE "public"."decision_queues" ADD CONSTRAINT "decision_queues_creator_check" CHECK ((
        ("decision_queues"."created_by_type" = 'agent' AND "decision_queues"."created_by_agent_id" IS NOT NULL AND "decision_queues"."created_by_user_id" IS NULL)
        OR ("decision_queues"."created_by_type" = 'user' AND "decision_queues"."created_by_agent_id" IS NULL AND "decision_queues"."created_by_user_id" IS NOT NULL)
        OR ("decision_queues"."created_by_type" = 'system' AND "decision_queues"."created_by_agent_id" IS NULL AND "decision_queues"."created_by_user_id" IS NULL)
      )) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."decision_queues"'::regclass AND conname = 'decision_queues_retention_days_check'
  ) THEN
    ALTER TABLE "public"."decision_queues" ADD CONSTRAINT "decision_queues_retention_days_check" CHECK ("decision_queues"."retention_days" IS NULL OR ("decision_queues"."retention_days" >= 1 AND "decision_queues"."retention_days" <= 3650)) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."decision_retention"'::regclass AND conname = 'decision_retention_archive_actor_check'
  ) THEN
    ALTER TABLE "public"."decision_retention" ADD CONSTRAINT "decision_retention_archive_actor_check" CHECK ((
        ("decision_retention"."archived_at" IS NULL AND "decision_retention"."archived_by_type" IS NULL AND "decision_retention"."archived_by_agent_id" IS NULL AND "decision_retention"."archived_by_user_id" IS NULL)
        OR ("decision_retention"."archived_at" IS NOT NULL AND "decision_retention"."archived_by_type" = 'system' AND "decision_retention"."archived_by_agent_id" IS NULL AND "decision_retention"."archived_by_user_id" IS NULL)
        OR ("decision_retention"."archived_at" IS NOT NULL AND "decision_retention"."archived_by_type" = 'agent' AND "decision_retention"."archived_by_agent_id" IS NOT NULL AND "decision_retention"."archived_by_user_id" IS NULL)
        OR ("decision_retention"."archived_at" IS NOT NULL AND "decision_retention"."archived_by_type" = 'user' AND "decision_retention"."archived_by_agent_id" IS NULL AND "decision_retention"."archived_by_user_id" IS NOT NULL)
      )) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."decision_triage_events"'::regclass AND conname = 'decision_triage_events_actor_check'
  ) THEN
    ALTER TABLE "public"."decision_triage_events" ADD CONSTRAINT "decision_triage_events_actor_check" CHECK ((
        ("decision_triage_events"."actor_type" = 'agent' AND "decision_triage_events"."actor_agent_id" IS NOT NULL AND "decision_triage_events"."actor_user_id" IS NULL)
        OR ("decision_triage_events"."actor_type" = 'user' AND "decision_triage_events"."actor_agent_id" IS NULL AND "decision_triage_events"."actor_user_id" IS NOT NULL)
        OR ("decision_triage_events"."actor_type" = 'system' AND "decision_triage_events"."actor_agent_id" IS NULL AND "decision_triage_events"."actor_user_id" IS NULL)
      )) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."decision_triage"'::regclass AND conname = 'decision_triage_actor_check'
  ) THEN
    ALTER TABLE "public"."decision_triage" ADD CONSTRAINT "decision_triage_actor_check" CHECK ((
        ("decision_triage"."set_by_type" = 'agent' AND "decision_triage"."set_by_agent_id" IS NOT NULL AND "decision_triage"."set_by_user_id" IS NULL)
        OR ("decision_triage"."set_by_type" = 'user' AND "decision_triage"."set_by_agent_id" IS NULL AND "decision_triage"."set_by_user_id" IS NOT NULL)
      )) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."decision_triage"'::regclass AND conname = 'decision_triage_decide_by_check'
  ) THEN
    ALTER TABLE "public"."decision_triage" ADD CONSTRAINT "decision_triage_decide_by_check" CHECK ((
        ("decision_triage"."decide_by" IS NULL AND "decision_triage"."decide_by_date" IS NULL)
        OR ("decision_triage"."decide_by" IN ('today', 'this_week', 'whenever') AND "decision_triage"."decide_by_date" IS NULL)
        OR ("decision_triage"."decide_by" = 'date' AND "decision_triage"."decide_by_date" IS NOT NULL)
      )) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."document_annotation_comments"'::regclass AND conname = 'document_annotation_comments_exactly_one_owner_chk'
  ) THEN
    ALTER TABLE "public"."document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_exactly_one_owner_chk" CHECK (num_nonnulls("document_annotation_comments"."issue_id", "document_annotation_comments"."routine_id", "document_annotation_comments"."case_id") = 1) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."document_annotation_threads"'::regclass AND conname = 'document_annotation_threads_exactly_one_owner_chk'
  ) THEN
    ALTER TABLE "public"."document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_exactly_one_owner_chk" CHECK (num_nonnulls("document_annotation_threads"."issue_id", "document_annotation_threads"."routine_id", "document_annotation_threads"."case_id") = 1) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."email_endpoints"'::regclass AND conname = 'email_endpoints_receive_mode_check'
  ) THEN
    ALTER TABLE "public"."email_endpoints" ADD CONSTRAINT "email_endpoints_receive_mode_check" CHECK ("email_endpoints"."receive_mode" in ('websocket', 'webhook')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."email_messages"'::regclass AND conname = 'email_messages_direction_check'
  ) THEN
    ALTER TABLE "public"."email_messages" ADD CONSTRAINT "email_messages_direction_check" CHECK ("email_messages"."direction" in ('inbound', 'outbound')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."email_sends"'::regclass AND conname = 'email_sends_outcome_check'
  ) THEN
    ALTER TABLE "public"."email_sends" ADD CONSTRAINT "email_sends_outcome_check" CHECK ("email_sends"."outcome" in ('queued', 'sent', 'delivered', 'failed', 'uncertain')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."goal_kpi_readings"'::regclass AND conname = 'goal_kpi_readings_source_check'
  ) THEN
    ALTER TABLE "public"."goal_kpi_readings" ADD CONSTRAINT "goal_kpi_readings_source_check" CHECK ("goal_kpi_readings"."source" in ('owner_reported', 'agent_verified', 'system')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."goal_why_requests"'::regclass AND conname = 'goal_why_requests_status_check'
  ) THEN
    ALTER TABLE "public"."goal_why_requests" ADD CONSTRAINT "goal_why_requests_status_check" CHECK ("goal_why_requests"."status" in ('open', 'answered')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."issue_inbox_archives"'::regclass AND conname = 'issue_inbox_archives_archived_by_actor_type_check'
  ) THEN
    ALTER TABLE "public"."issue_inbox_archives" ADD CONSTRAINT "issue_inbox_archives_archived_by_actor_type_check" CHECK ("issue_inbox_archives"."archived_by_actor_type" in ('user', 'agent')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."issue_question_response_deliveries"'::regclass AND conname = 'issue_question_response_deliveries_mode_check'
  ) THEN
    ALTER TABLE "public"."issue_question_response_deliveries" ADD CONSTRAINT "issue_question_response_deliveries_mode_check" CHECK ("issue_question_response_deliveries"."delivery_mode" IS NULL OR "issue_question_response_deliveries"."delivery_mode" IN ('steered', 'coalesced', 'wake_fallback')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."issue_question_response_deliveries"'::regclass AND conname = 'issue_question_response_deliveries_status_check'
  ) THEN
    ALTER TABLE "public"."issue_question_response_deliveries" ADD CONSTRAINT "issue_question_response_deliveries_status_check" CHECK ("issue_question_response_deliveries"."status" IN ('pending', 'delivering', 'delivered', 'fallback_queued', 'failed')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."issues"'::regclass AND conname = 'issues_conversation_identity_check'
  ) THEN
    ALTER TABLE "public"."issues" ADD CONSTRAINT "issues_conversation_identity_check" CHECK ((
      "issues"."conversation_agent_id" is null and "issues"."conversation_user_id" is null and "issues"."conversation_state" is null
    ) or (
      "issues"."conversation_agent_id" is not null and "issues"."conversation_user_id" is not null
      and "issues"."assignee_agent_id" = "issues"."conversation_agent_id" and "issues"."assignee_agent_id" is not null
      and "issues"."assignee_user_id" is null and "issues"."conversation_state" is not null
      and "issues"."conversation_state" in ('active', 'waiting')
      and "issues"."status" not in ('done', 'cancelled')
    )) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."managed_agent_profiles"'::regclass AND conname = 'managed_agent_profiles_beta_check'
  ) THEN
    ALTER TABLE "public"."managed_agent_profiles" ADD CONSTRAINT "managed_agent_profiles_beta_check" CHECK ("managed_agent_profiles"."beta_version" = 'managed-agents-2026-04-01') NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."managed_agent_profiles"'::regclass AND conname = 'managed_agent_profiles_positive_budget_check'
  ) THEN
    ALTER TABLE "public"."managed_agent_profiles" ADD CONSTRAINT "managed_agent_profiles_positive_budget_check" CHECK ("managed_agent_profiles"."default_max_list_cost_cents" > 0) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."managed_agent_profiles"'::regclass AND conname = 'managed_agent_profiles_qualified_revision_check'
  ) THEN
    ALTER TABLE "public"."managed_agent_profiles" ADD CONSTRAINT "managed_agent_profiles_qualified_revision_check" CHECK (("managed_agent_profiles"."qualified_at" IS NULL AND "managed_agent_profiles"."qualified_revision" IS NULL) OR ("managed_agent_profiles"."qualified_at" IS NOT NULL AND "managed_agent_profiles"."qualification" <> '{}'::jsonb AND "managed_agent_profiles"."qualified_revision" ~ '^sha256:[0-9a-f]{64}$')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."managed_agent_profiles"'::regclass AND conname = 'managed_agent_profiles_service_check'
  ) THEN
    ALTER TABLE "public"."managed_agent_profiles" ADD CONSTRAINT "managed_agent_profiles_service_check" CHECK ("managed_agent_profiles"."service" = 'anthropic_managed_agents') NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."native_run_finalizations"'::regclass AND conname = 'native_run_finalizations_assessment_requires_result_check'
  ) THEN
    ALTER TABLE "public"."native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_assessment_requires_result_check" CHECK ("native_run_finalizations"."assessment_id" is null or "native_run_finalizations"."result_id" is not null) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."native_run_finalizations"'::regclass AND conname = 'native_run_finalizations_decision_requires_assessment_check'
  ) THEN
    ALTER TABLE "public"."native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_decision_requires_assessment_check" CHECK ("native_run_finalizations"."decision_id" is null or "native_run_finalizations"."assessment_id" is not null) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."pipeline_automation_executions"'::regclass AND conname = 'pipeline_automation_executions_status_check'
  ) THEN
    ALTER TABLE "public"."pipeline_automation_executions" ADD CONSTRAINT "pipeline_automation_executions_status_check" CHECK ("pipeline_automation_executions"."status" in ('succeeded', 'failed')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."pipeline_case_blockers"'::regclass AND conname = 'pipeline_case_blockers_no_self_block_check'
  ) THEN
    ALTER TABLE "public"."pipeline_case_blockers" ADD CONSTRAINT "pipeline_case_blockers_no_self_block_check" CHECK ("pipeline_case_blockers"."case_id" <> "pipeline_case_blockers"."blocked_by_case_id") NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."pipeline_case_events"'::regclass AND conname = 'pipeline_case_events_actor_type_check'
  ) THEN
    ALTER TABLE "public"."pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_actor_type_check" CHECK ("pipeline_case_events"."actor_type" in ('user', 'agent', 'system')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."pipeline_case_events"'::regclass AND conname = 'pipeline_case_events_agent_run_check'
  ) THEN
    ALTER TABLE "public"."pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_agent_run_check" CHECK ("pipeline_case_events"."actor_type" <> 'agent' or "pipeline_case_events"."run_id" is not null) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."pipeline_case_events"'::regclass AND conname = 'pipeline_case_events_type_check'
  ) THEN
    ALTER TABLE "public"."pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_type_check" CHECK ("pipeline_case_events"."type" in (
        'ingested',
        'updated',
        'claimed',
        'lease_released',
        'lease_expired',
        'transitioned',
        'transition_forced',
        'transition_suggested',
        'suggestion_resolved',
        'review_decided',
        'conversation_opened',
        'issue_linked',
        'issue_unlinked',
        'project_linked',
        'project_unlinked',
        'automation_executed',
        'automation_failed',
        'automation_retry_requested',
        'automation_effects_retired',
        'automation_retry_dispatched',
        'blockers_set',
        'blockers_resolved',
        'children_terminal',
        'upstream_drift',
        'drift_acknowledged'
      )) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."pipeline_case_evidence"'::regclass AND conname = 'pipeline_case_evidence_kind_check'
  ) THEN
    ALTER TABLE "public"."pipeline_case_evidence" ADD CONSTRAINT "pipeline_case_evidence_kind_check" CHECK (("pipeline_case_evidence"."kind" = 'attachment' and "pipeline_case_evidence"."attachment_id" is not null)
        or ("pipeline_case_evidence"."kind" = 'document' and "pipeline_case_evidence"."document_id" is not null)
        or ("pipeline_case_evidence"."kind" = 'link' and "pipeline_case_evidence"."url" is not null)) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."pipeline_case_issue_links"'::regclass AND conname = 'pipeline_case_issue_links_role_check'
  ) THEN
    ALTER TABLE "public"."pipeline_case_issue_links" ADD CONSTRAINT "pipeline_case_issue_links_role_check" CHECK ("pipeline_case_issue_links"."role" in ('origin', 'conversation', 'work', 'automation')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."pipeline_cases"'::regclass AND conname = 'pipeline_cases_lease_owner_type_check'
  ) THEN
    ALTER TABLE "public"."pipeline_cases" ADD CONSTRAINT "pipeline_cases_lease_owner_type_check" CHECK ("pipeline_cases"."lease_owner_type" is null or "pipeline_cases"."lease_owner_type" in ('user', 'agent')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."pipeline_cases"'::regclass AND conname = 'pipeline_cases_terminal_kind_check'
  ) THEN
    ALTER TABLE "public"."pipeline_cases" ADD CONSTRAINT "pipeline_cases_terminal_kind_check" CHECK ("pipeline_cases"."terminal_kind" is null or "pipeline_cases"."terminal_kind" in ('done', 'cancelled')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."pipeline_field_definitions"'::regclass AND conname = 'pipeline_field_definitions_type_check'
  ) THEN
    ALTER TABLE "public"."pipeline_field_definitions" ADD CONSTRAINT "pipeline_field_definitions_type_check" CHECK ("pipeline_field_definitions"."type" in ('text', 'long_text', 'number', 'boolean', 'date', 'select', 'multi_select', 'email', 'phone', 'url')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."pipeline_stages"'::regclass AND conname = 'pipeline_stages_kind_check'
  ) THEN
    ALTER TABLE "public"."pipeline_stages" ADD CONSTRAINT "pipeline_stages_kind_check" CHECK ("pipeline_stages"."kind" in ('working', 'review', 'done', 'cancelled')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."remote_agent_profiles"'::regclass AND conname = 'remote_agent_profiles_qualified_revision_check'
  ) THEN
    ALTER TABLE "public"."remote_agent_profiles" ADD CONSTRAINT "remote_agent_profiles_qualified_revision_check" CHECK (("remote_agent_profiles"."qualified_at" IS NULL AND "remote_agent_profiles"."qualified_revision" IS NULL) OR ("remote_agent_profiles"."qualified_at" IS NOT NULL AND "remote_agent_profiles"."qualification" <> '{}'::jsonb AND "remote_agent_profiles"."qualified_revision" ~ '^sha256:[0-9a-f]{64}$')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."remote_agent_profiles"'::regclass AND conname = 'remote_agent_profiles_service_check'
  ) THEN
    ALTER TABLE "public"."remote_agent_profiles" ADD CONSTRAINT "remote_agent_profiles_service_check" CHECK ("remote_agent_profiles"."service" = 'aws_bedrock_agentcore_harness') NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."strategy_board_emails"'::regclass AND conname = 'strategy_board_emails_kind_check'
  ) THEN
    ALTER TABLE "public"."strategy_board_emails" ADD CONSTRAINT "strategy_board_emails_kind_check" CHECK ("strategy_board_emails"."kind" in ('meeting_reminder', 'slippage_alert', 'why_request')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."strategy_board_emails"'::regclass AND conname = 'strategy_board_emails_status_check'
  ) THEN
    ALTER TABLE "public"."strategy_board_emails" ADD CONSTRAINT "strategy_board_emails_status_check" CHECK ("strategy_board_emails"."status" in ('queued', 'failed')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."strategy_board_packs"'::regclass AND conname = 'strategy_board_packs_status_check'
  ) THEN
    ALTER TABLE "public"."strategy_board_packs" ADD CONSTRAINT "strategy_board_packs_status_check" CHECK ("strategy_board_packs"."status" in ('draft', 'accepted')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."support_queues"'::regclass AND conname = 'support_queues_client_code_check'
  ) THEN
    ALTER TABLE "public"."support_queues" ADD CONSTRAINT "support_queues_client_code_check" CHECK ("support_queues"."client_code" ~ '^[A-Z0-9]{2,12}$') NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."support_tickets"'::regclass AND conname = 'support_tickets_category_check'
  ) THEN
    ALTER TABLE "public"."support_tickets" ADD CONSTRAINT "support_tickets_category_check" CHECK ("support_tickets"."category" in ('general', 'install', 'reliability')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."support_tickets"'::regclass AND conname = 'support_tickets_priority_check'
  ) THEN
    ALTER TABLE "public"."support_tickets" ADD CONSTRAINT "support_tickets_priority_check" CHECK ("support_tickets"."priority" in ('P1', 'P2', 'P3')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."tool_connection_installs"'::regclass AND conname = 'tool_connection_installs_target_type_check'
  ) THEN
    ALTER TABLE "public"."tool_connection_installs" ADD CONSTRAINT "tool_connection_installs_target_type_check" CHECK ("tool_connection_installs"."target_type" in ('company', 'agent')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."tool_connections"'::regclass AND conname = 'tool_connections_auth_kind_check'
  ) THEN
    ALTER TABLE "public"."tool_connections" ADD CONSTRAINT "tool_connections_auth_kind_check" CHECK ("tool_connections"."auth_kind" in ('oauth', 'api_key', 'none')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."tool_connections"'::regclass AND conname = 'tool_connections_channel_transport_check'
  ) THEN
    ALTER TABLE "public"."tool_connections" ADD CONSTRAINT "tool_connections_channel_transport_check" CHECK ((
      ("tool_connections"."connection_purpose" = 'tool' and "tool_connections"."transport" not in ('chat_sdk', 'runtime_auth'))
      or
      ("tool_connections"."connection_purpose" = 'channel' and ("tool_connections"."transport" = 'chat_sdk' or ("tool_connections"."transport" = 'rest_api' and "tool_connections"."config"->>'provider' = 'agentmail')))
      or
      ("tool_connections"."connection_purpose" = 'ai' and "tool_connections"."transport" = 'runtime_auth')
    )) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."tool_connections"'::regclass AND conname = 'tool_connections_credential_policy_check'
  ) THEN
    ALTER TABLE "public"."tool_connections" ADD CONSTRAINT "tool_connections_credential_policy_check" CHECK ("tool_connections"."credential_policy" in ('shared', 'per_user', 'per_user_with_fallback', 'per_agent')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."tool_connections"'::regclass AND conname = 'tool_connections_credential_source_check'
  ) THEN
    ALTER TABLE "public"."tool_connections" ADD CONSTRAINT "tool_connections_credential_source_check" CHECK ("tool_connections"."credential_source" in ('paperclip_vault', 'vercel_connect')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."tool_connections"'::regclass AND conname = 'tool_connections_credential_source_one_of_check'
  ) THEN
    ALTER TABLE "public"."tool_connections" ADD CONSTRAINT "tool_connections_credential_source_one_of_check" CHECK ((
      ("tool_connections"."credential_source" = 'paperclip_vault' and "tool_connections"."external_credential" is null)
      or
      ("tool_connections"."credential_source" = 'vercel_connect' and "tool_connections"."external_credential" is not null and jsonb_array_length("tool_connections"."credential_refs") = 0 and jsonb_array_length("tool_connections"."credential_secret_refs") = 0)
    )) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."tool_connections"'::regclass AND conname = 'tool_connections_ownership_check'
  ) THEN
    ALTER TABLE "public"."tool_connections" ADD CONSTRAINT "tool_connections_ownership_check" CHECK ("tool_connections"."ownership" in ('platform_shared', 'platform_provisioned', 'customer', 'dcr')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."tool_connections"'::regclass AND conname = 'tool_connections_purpose_check'
  ) THEN
    ALTER TABLE "public"."tool_connections" ADD CONSTRAINT "tool_connections_purpose_check" CHECK ("tool_connections"."connection_purpose" in ('tool', 'channel', 'ai')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."tool_connections"'::regclass AND conname = 'tool_connections_transport_check'
  ) THEN
    ALTER TABLE "public"."tool_connections" ADD CONSTRAINT "tool_connections_transport_check" CHECK ("tool_connections"."transport" in ('mcp_remote', 'rest_api', 'local_stdio', 'chat_sdk', 'runtime_auth')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."user_inbox_agent_policies"'::regclass AND conname = 'user_inbox_agent_policies_mode_check'
  ) THEN
    ALTER TABLE "public"."user_inbox_agent_policies" ADD CONSTRAINT "user_inbox_agent_policies_mode_check" CHECK ("user_inbox_agent_policies"."mode" in ('open', 'allowlist', 'disabled')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"public"."work_assessments"'::regclass AND conname = 'work_assessments_trigger_actor_company_check'
  ) THEN
    ALTER TABLE "public"."work_assessments" ADD CONSTRAINT "work_assessments_trigger_actor_company_check" CHECK ("work_assessments"."trigger_actor_company_id" = "work_assessments"."company_id") NOT VALID;
  END IF;
END $$;

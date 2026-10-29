import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const GREATSTONE_COMPANY_ID = "34dad57e-b5ad-4a72-9400-9eba645c99f6";

const requiredText = (value, name) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`R1 missing ${name}`);
  return value.trim();
};

export function validateSourceContract(contract, { companyId, sourceRef, databaseUrl, out }) {
  if (companyId !== GREATSTONE_COMPANY_ID || contract?.companyId !== GREATSTONE_COMPANY_ID)
    throw new Error("R1 capture is restricted to the Greatstone company");
  if (!contract || contract.schema !== "gsam.r1-source-contract/v1") throw new Error("R1 missing source contract schema");
  if (contract.route !== "direct-live-read-only") throw new Error("R1 requires the direct live read-only route");
  if (contract.companyId !== companyId) throw new Error("R1 source contract company mismatch");
  if (contract.sourceRef !== sourceRef) throw new Error("R1 source reference mismatch");
  for (const field of ["instanceId", "dataDirectory", "operator", "approvalRef", "destination", "deletionOwner", "role", "database"])
    requiredText(contract[field], field);
  if (contract.instanceId !== "default" || !isAbsolute(contract.dataDirectory) || !isAbsolute(contract.destination))
    throw new Error("R1 source must be the named default instance with absolute local paths");
  if (!Number.isInteger(contract.port) || contract.port < 1 || contract.port > 65535) throw new Error("R1 missing source port");
  if (!Number.isFinite(Date.parse(contract.retentionUntil ?? ""))) throw new Error("R1 missing retention deadline");
  if (Date.parse(contract.retentionUntil) <= Date.now()) throw new Error("R1 retention deadline has passed");
  const url = new URL(databaseUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") throw new Error("R1 source must be loopback");
  if (Number(url.port || 5432) !== contract.port || decodeURIComponent(url.pathname.slice(1)) !== contract.database || decodeURIComponent(url.username) !== contract.role)
    throw new Error("R1 connection does not match approved source identity");
  const destination = resolve(contract.destination);
  if (!out.startsWith(`${destination}/`)) throw new Error("R1 output is outside approved destination");
  const coverage = contract.coverage;
  if (!coverage || coverage.kind !== "source-inventory") throw new Error("R1 missing source coverage proof");
  for (const field of ["checkedAt", "checkedBy", "method", "allCurrentCompanyIssues", "fullSevenDayActivity", "olderRelevantRuns", "runRetentionPolicy", "activityRetentionPolicy"])
    requiredText(coverage[field], `coverage.${field}`);
  for (const field of ["method", "allCurrentCompanyIssues", "fullSevenDayActivity", "olderRelevantRuns", "runRetentionPolicy", "activityRetentionPolicy"])
    if (/<|>|^verified$/i.test(coverage[field])) throw new Error(`R1 coverage.${field} needs an evidence reference`);
  if (!Number.isFinite(Date.parse(coverage.checkedAt))) throw new Error("R1 invalid coverage timestamp");
  if (coverage.complete !== true) throw new Error("R1 source coverage is incomplete");
  return contract;
}

export function readSourceContract(path, options) {
  return validateSourceContract(JSON.parse(readFileSync(path, "utf8")), options);
}

export async function verifyReadOnlySource(tx, contract) {
  const rows = await tx.unsafe(`select current_user as "role", current_database() as "database",
    inet_server_port() as "port", current_setting('transaction_read_only') as "readOnly",
    current_setting('transaction_isolation') as "isolation", r.rolsuper as "superuser",
    r.rolcreaterole as "createRole", r.rolcreatedb as "createDb", r.rolreplication as "replication",
    r.rolbypassrls as "bypassRls",
    current_setting('default_transaction_read_only') as "defaultReadOnly",
    exists (select 1 from pg_db_role_setting s where s.setrole = r.oid
      and s.setdatabase in (0, (select oid from pg_database where datname = current_database()))
      and 'default_transaction_read_only=on' = any(s.setconfig)) as "roleReadOnlyDefault",
    (has_database_privilege(current_user, current_database(), 'CREATE')
      or has_database_privilege(current_user, current_database(), 'TEMP')
      or exists (select 1 from pg_namespace n where n.nspname not like 'pg_%'
        and n.nspname <> 'information_schema' and has_schema_privilege(current_user, n.oid, 'CREATE'))
      or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
          and c.relkind in ('r','p','v','m','f')
          and (has_table_privilege(current_user,c.oid,'INSERT') or has_table_privilege(current_user,c.oid,'UPDATE')
            or has_table_privilege(current_user,c.oid,'DELETE') or has_table_privilege(current_user,c.oid,'TRUNCATE')))
      or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname not like 'pg_%' and n.nspname <> 'information_schema' and c.relkind = 'S'
          and (has_sequence_privilege(current_user,c.oid,'USAGE') or has_sequence_privilege(current_user,c.oid,'UPDATE')))
      or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
          and p.prosecdef and has_function_privilege(current_user,p.oid,'EXECUTE'))) as "hasWriteGrant"
    from pg_roles r where r.rolname = current_user`);
  const row = rows[0];
  if (!row || row.role !== contract.role || row.database !== contract.database || Number(row.port) !== contract.port)
    throw new Error("R1 connected source identity mismatch");
  if (row.readOnly !== "on" || row.isolation !== "repeatable read" || row.defaultReadOnly !== "on" || row.roleReadOnlyDefault !== true || row.superuser || row.createRole || row.createDb || row.replication || row.bypassRls || row.hasWriteGrant)
    throw new Error("R1 connection is not a restricted read-only snapshot role");
}

# Client people dry run (GRE-2624)

This read-only tool compares exported copies of GSAM people and website accounts. It does not connect to a database, call the website, create users or change any record. Run it against a copy of one company's data. Keep the input and report outside the repository: both contain client email addresses.

## Snapshot contract

Supply one JSON object with `companyId`, `organisations`, `people`, `websiteUsers` and, optionally, `decisions`.

```json
{
  "companyId": "company-a",
  "organisations": [
    { "id": "crm-org-a", "companyId": "company-a", "websiteOrganisationId": "site-org-a" }
  ],
  "people": [
    { "kind": "pipedrive_person", "id": "crm-person-a", "companyId": "company-a", "organisationId": "crm-org-a", "email": "person@example.test", "websiteUserId": null }
  ],
  "websiteUsers": [
    { "id": "site-user-a", "email": "person@example.test", "organisationIds": ["site-org-a"] }
  ],
  "decisions": []
}
```

The `organisations` array comes from a **copy** of GSAM `organisations` and includes the person-confirmed `website_organisation_id` set by GRE-2611. Use the GSAM row id as each person's `organisationId`. Map `organisation_contacts` to `gsam_contact`, or to `pipedrive_person` when `source = 'pipedrive'`. Include other GSAM organisation people as `organisation_member` with their source row id. Map old standalone Everest Supabase users to `old_supabase_user` only after the copy has an explicit GSAM organisation id for each; use `null` when it does not. Do not infer an organisation from email, name or domain. `websiteUsers` must come from a copy of the website's Better Auth users and membership rows; each `organisationIds` value is a website organisation id. Do not put passwords, tokens or other account fields in the export.

Run from the repository root:

```sh
pnpm exec tsx server/scripts/client-people-dry-run.ts /path/to/copied-snapshot.json /path/to/new-report.json
```

The report path must be new. The tool writes it with owner-only permissions and refuses to overwrite an earlier report. The terminal prints only counts. The JSON report includes one row per source record, the four counts (`matched`, `wouldCreate`, `ambiguous`, `leftBehind`), the number of distinct website accounts proposed for creation, and `reviewList`. `wouldCreate` means **proposed only**; no website account is created. Repeated source records for the same email and linked organisation share a creation key, so the distinct count does not propose duplicate accounts.

## Review decisions

An email match is accepted only when exactly one website user has that email **and** that user belongs to the linked website organisation. A stored website user id is accepted only when its membership agrees with the linked organisation and its email evidence does not conflict. Other candidates go to `reviewList`; missing organisation links or emails stay behind with a reason.

A person may add a `decisions` entry for an ambiguous row, then run the tool again:

```json
{
  "kind": "pipedrive_person",
  "id": "crm-person-a",
  "websiteUserId": "site-user-a",
  "websiteOrganisationId": "site-org-a",
  "confirmedBy": "reviewer-id",
  "confirmedAt": "2026-10-26T10:00:00Z"
}
```

The tool checks that the selected website user belongs to the linked organisation and records the reviewer in the new report. It rejects decisions for rows outside the ambiguous list. This local field records review evidence but does not authenticate the reviewer or authorise a live merge. Any live change still needs GRE-2567's website create-user call, a verified backup and John's approval card. The eventual apply step must recheck current website membership and human approval before writing.

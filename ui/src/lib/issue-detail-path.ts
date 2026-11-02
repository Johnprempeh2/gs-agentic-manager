/**
 * A task URL (/issues/:issueId, with or without a company prefix). Shared by
 * the app and by the build, which preloads the task page on these URLs.
 */
export const ISSUE_DETAIL_PATH = /^(?:\/[^/]+)?\/issues\/([^/]+)\/?$/;

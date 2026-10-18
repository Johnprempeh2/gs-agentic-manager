import { pgTable, text, timestamp, boolean, integer, index, uniqueIndex, jsonb, uuid } from "drizzle-orm/pg-core";

export const authUsers = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  keyboardShortcuts: boolean("keyboard_shortcuts").notNull().default(false),
  // Better Auth's two-factor plugin: true once the person has confirmed an
  // authenticator app, after which sign-in asks for a code.
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const authSessions = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
});

/**
 * Better Auth's `account` model. Every column here has to exist for the
 * Drizzle adapter to accept the table at all: the adapter validates the
 * model's fields against the schema on each write and throws
 * `The field "<name>" does not exist in the "account" Drizzle schema`
 * when one is missing, which surfaces as a 500 on sign-up.
 *
 * `issuer` is the account namespace Better Auth 1.7 added. It is
 * `local:credential` for email/password accounts and
 * `local:oauth:<providerId>` for social accounts that do not declare an
 * issuer of their own, and it pairs with `account_id` as the stable
 * provider-side key — hence the unique index, which mirrors the
 * `(issuer, accountId)` unique index Better Auth declares on the model.
 */
export const authAccounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    issuerAccountIdUq: uniqueIndex("account_issuer_account_id_uq").on(table.issuer, table.accountId),
  }),
);

export const authVerifications = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

/**
 * Better Auth's `twoFactor` model: one row per person with two-step sign-in.
 * `secret` and `backupCodes` are encrypted by Better Auth with the auth
 * secret before they are stored. `failedVerificationCount` and `lockedUntil`
 * are Better Auth's own lock after repeated wrong codes.
 */
export const authTwoFactors = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (table) => ({
    userIdIdx: index("two_factor_user_id_idx").on(table.userId),
    secretIdx: index("two_factor_secret_idx").on(table.secret),
  }),
);

/**
 * Wrong-password counts for the per-account sign-in lockout
 * (server/src/auth/sign-in-lockout.ts), kept here so a restart does not clear
 * them. Instance-wide like the rest of sign-in. The key is a SHA-256 of the
 * normalised email, so emails people try that have no account are not stored.
 */
export const authSignInLockouts = pgTable(
  "sign_in_lockout",
  {
    accountKey: text("account_key").primaryKey(),
    /** Epoch milliseconds of each wrong password inside the current window. */
    failureTimes: jsonb("failure_times").$type<number[]>().notNull().default([]),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    updatedAtIdx: index("sign_in_lockout_updated_at_idx").on(table.updatedAt),
  }),
);

/**
 * Each person's recent sign-in attempts (server/src/auth/sign-in-history.ts),
 * shown to them on Profile so they can spot a password someone else knows.
 * Only attempts on an existing account are kept, and rows older than 90 days
 * are removed as new ones come in.
 */
export const authSignInEvents = pgTable(
  "sign_in_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    /** signed_in, wrong_password, or code_needed (password right, two-step code not yet given). */
    outcome: text("outcome").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index("sign_in_event_user_created_idx").on(table.userId, table.createdAt),
  }),
);

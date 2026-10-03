import { describe, expect, it } from "vitest";
import { isDeadlockDetected, isUniqueViolation } from "../db-errors.js";

describe("isDeadlockDetected", () => {
  it("matches a bare or Drizzle-wrapped postgres.js deadlock", () => {
    expect(isDeadlockDetected({ code: "40P01" })).toBe(true);
    const wrapped = new Error("Failed query: select ... from \"heartbeat_runs\" ... for no key update");
    (wrapped as { cause?: unknown }).cause = { code: "40P01", message: "deadlock detected" };
    expect(isDeadlockDetected(wrapped)).toBe(true);
  });

  it("ignores other errors and stops on a self-referential cause chain", () => {
    expect(isDeadlockDetected({ cause: { code: "40001" } })).toBe(false);
    expect(isDeadlockDetected(new Error("deadlock detected"))).toBe(false);
    expect(isDeadlockDetected(null)).toBe(false);
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(isDeadlockDetected(looped)).toBe(false);
  });
});

const CONSTRAINT = "issues_open_routine_execution_uq";

describe("isUniqueViolation", () => {
  it("matches a bare postgres.js unique violation", () => {
    expect(isUniqueViolation({ code: "23505", constraint_name: CONSTRAINT }, CONSTRAINT)).toBe(true);
  });

  it("matches the node-postgres constraint field", () => {
    expect(isUniqueViolation({ code: "23505", constraint: CONSTRAINT }, CONSTRAINT)).toBe(true);
  });

  it("matches the error Drizzle wraps around the driver failure", () => {
    const wrapped = new Error("Failed query: update \"issues\" set \"execution_run_id\" = $1");
    (wrapped as { cause?: unknown }).cause = { code: "23505", constraint_name: CONSTRAINT };
    expect(isUniqueViolation(wrapped, CONSTRAINT)).toBe(true);
  });

  it("falls back to the driver message when the constraint name is not surfaced", () => {
    expect(isUniqueViolation({
      cause: {
        code: "23505",
        message: `duplicate key value violates unique constraint "${CONSTRAINT}"`,
      },
    }, CONSTRAINT)).toBe(true);
  });

  it("matches any unique violation when no constraint is named", () => {
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
  });

  it("ignores a unique violation on a different constraint", () => {
    expect(isUniqueViolation({ cause: { code: "23505", constraint_name: "issues_identifier_idx" } }, CONSTRAINT))
      .toBe(false);
  });

  it("ignores errors that are not unique violations", () => {
    expect(isUniqueViolation({ cause: { code: "23503", constraint_name: CONSTRAINT } }, CONSTRAINT)).toBe(false);
    expect(isUniqueViolation(new Error("boom"), CONSTRAINT)).toBe(false);
    expect(isUniqueViolation(null, CONSTRAINT)).toBe(false);
    expect(isUniqueViolation(undefined, CONSTRAINT)).toBe(false);
  });

  it("stops walking a self-referential cause chain", () => {
    const looped: { cause?: unknown } = {};
    looped.cause = looped;
    expect(isUniqueViolation(looped, CONSTRAINT)).toBe(false);
  });
});

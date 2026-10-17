import { describe, expect, it } from "vitest";
import { createSignInLockout } from "../auth/sign-in-lockout.js";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("createSignInLockout", () => {
  const options = { maxFailures: 3, windowMs: 60_000, lockMs: 300_000 };

  it("locks an account after the set number of failures inside the window", () => {
    const c = clock();
    const lockout = createSignInLockout({ ...options, now: c.now });
    lockout.recordFailure("Ben@Example.com");
    lockout.recordFailure("ben@example.com");
    expect(lockout.lockedFor("ben@example.com")).toBe(0);
    lockout.recordFailure(" ben@example.com ");
    expect(lockout.lockedFor("BEN@example.com")).toBe(300_000);
    c.advance(299_999);
    expect(lockout.lockedFor("ben@example.com")).toBe(1);
    c.advance(1);
    expect(lockout.lockedFor("ben@example.com")).toBe(0);
  });

  it("forgets failures older than the window", () => {
    const c = clock();
    const lockout = createSignInLockout({ ...options, now: c.now });
    lockout.recordFailure("a@example.com");
    lockout.recordFailure("a@example.com");
    c.advance(60_000);
    lockout.recordFailure("a@example.com");
    expect(lockout.lockedFor("a@example.com")).toBe(0);
  });

  it("clears the count on a successful sign-in", () => {
    const c = clock();
    const lockout = createSignInLockout({ ...options, now: c.now });
    lockout.recordFailure("a@example.com");
    lockout.recordFailure("a@example.com");
    lockout.recordSuccess("a@example.com");
    lockout.recordFailure("a@example.com");
    expect(lockout.lockedFor("a@example.com")).toBe(0);
  });

  it("keeps accounts apart and ignores values that are not emails", () => {
    const lockout = createSignInLockout({ ...options, maxFailures: 1 });
    lockout.recordFailure("a@example.com");
    lockout.recordFailure(undefined);
    lockout.recordFailure({ email: "b@example.com" });
    expect(lockout.lockedFor("a@example.com")).toBeGreaterThan(0);
    expect(lockout.lockedFor("b@example.com")).toBe(0);
    expect(lockout.lockedFor(undefined)).toBe(0);
  });
});

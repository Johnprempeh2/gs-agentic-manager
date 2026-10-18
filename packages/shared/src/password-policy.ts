/**
 * The rule for a new password, shared by the sign-up pages, the server's
 * sign-up and password-change checks, and the host's password reset. A client
 * instance is on the public internet, so a password must hold up against
 * guessing: long enough, not a well-known password, and not built from the
 * person's own email.
 */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_RULE_HINT = `At least ${PASSWORD_MIN_LENGTH} characters. A short sentence works well.`;

// Lower-cased. Lists of leaked passwords are full of these at 12 characters
// and over; shorter ones are already refused by length.
const COMMON_PASSWORDS = new Set([
  "123456789012",
  "1234567890123",
  "12345678901234",
  "123456789123",
  "1q2w3e4r5t6y",
  "1qaz2wsx3edc",
  "abc123456789",
  "abcdefghijkl",
  "administrator",
  "asdfghjkl123",
  "football1234",
  "iloveyou1234",
  "letmein12345",
  "passw0rd1234",
  "password1234",
  "password12345",
  "password123!",
  "password@123",
  "passwordpassword",
  "q1w2e3r4t5y6",
  "qwerty123456",
  "qwertyuiop12",
  "qwertyuiop123",
  "qwertyuiopasdfgh",
  "welcome12345",
  "welcome@1234",
  "changeme1234",
  "greatstone123",
  "greatstone1234",
]);

/**
 * Why `password` cannot be used, as a sentence to show the person, or null
 * when it is fine. `email` (when known) stops a password made from the
 * account's own address (the part before the @ making up half or more of it).
 */
export function passwordProblem(password: string, context: { email?: string | null } = {}): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters. A short sentence works well.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  const lower = password.toLowerCase();
  if (new Set(lower).size <= 2) {
    return "Use more than one or two different characters.";
  }
  if (COMMON_PASSWORDS.has(lower)) {
    return "That password is too well known. Pick something only you would use.";
  }
  const local = context.email?.trim().toLowerCase().split("@")[0] ?? "";
  // Only when the address is most of the password: a long password that
  // happens to contain a short name is fine.
  if (local.length >= 4 && lower.includes(local) && local.length * 2 >= lower.length) {
    return "Do not build the password from your email address.";
  }
  return null;
}

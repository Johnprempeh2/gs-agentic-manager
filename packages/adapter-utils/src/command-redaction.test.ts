import { describe, expect, it } from "vitest";
import {
  REDACTED_COMMAND_TEXT_VALUE,
  redactCommandText,
  redactDiagnosticText,
} from "./command-redaction.js";

describe("redactCommandText MIME types (GRE-809)", () => {
  const officeMimeTypes = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    "application/vnd.ms-excel.sheet.macroEnabled.12",
  ];

  it.each(officeMimeTypes)("keeps %s intact", (mimeType) => {
    expect(redactCommandText(mimeType)).toBe(mimeType);
    const field = `{"mimeType":"${mimeType}","filename":"report.docx"}`;
    expect(redactCommandText(field)).toBe(field);
    const header = `Content-Type: ${mimeType}; charset=binary`;
    expect(redactCommandText(header)).toBe(header);
  });

  it("still redacts a JWT next to a MIME type", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqb2huIn0.c2lnbmF0dXJlLXZhbHVl";
    const input = `application/vnd.openxmlformats-officedocument.wordprocessingml.document token ${jwt}`;
    const output = redactCommandText(input);
    expect(output).not.toContain(jwt);
    expect(output).toContain(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("still redacts a JWT that is not in a vendor MIME subtype", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqb2huIn0.c2lnbmF0dXJlLXZhbHVl";
    expect(redactCommandText(`application/${jwt}`)).toBe(
      `application/${REDACTED_COMMAND_TEXT_VALUE}`,
    );
    expect(redactCommandText(`notamime/vnd.${jwt}`)).toBe(
      `notamime/vnd.${REDACTED_COMMAND_TEXT_VALUE}`,
    );
    expect(redactCommandText(`path/to/${jwt}`)).toBe(
      `path/to/${REDACTED_COMMAND_TEXT_VALUE}`,
    );
  });
});

describe("redactDiagnosticText", () => {
  it("redacts a JSON secret field value", () => {
    const input = '{"token":"opaque-value","status":"error"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("opaque-value");
    expect(output).toContain(`"token":"${REDACTED_COMMAND_TEXT_VALUE}"`);
    // The non-secret field keeps its value.
    expect(output).toContain('"status":"error"');
  });

  it("redacts an api_key JSON field with whitespace around the colon", () => {
    const input = '{ "api_key" : "sk-secret-123" }';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("sk-secret-123");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an escaped-JSON secret field value", () => {
    // A diagnostic can carry a JSON string, so the double quotes appear as `\"`.
    const input = '{\\"token\\":\\"opaque-value\\"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("opaque-value");
    expect(output).toContain(
      `\\"token\\":\\"${REDACTED_COMMAND_TEXT_VALUE}\\"`,
    );
  });

  it("still redacts a shell KEY=value secret", () => {
    const input = "ANTHROPIC_API_KEY=super-secret-value claude --print";
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("super-secret-value");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an escaped quoted assignment across a literal newline", () => {
    const input = String.raw`authorization=\"Bearer first-line
second-line\" status=401`;
    const expected = String.raw`authorization=\"***REDACTED***\" status=401`;
    const output = redactDiagnosticText(input);
    expect(output).toBe(expected);
    expect(redactDiagnosticText(output)).toBe(expected);
  });

  it("keeps non-secret text and non-secret JSON fields intact", () => {
    const input = '{"status":"ok","message":"probe finished"}';
    expect(redactDiagnosticText(input)).toBe(input);
  });

  it("redacts the secret but keeps a non-secret marker in the same string", () => {
    const input = 'DIAGMARKER1234 said {"authorization":"Bearer opaque"}';
    const output = redactDiagnosticText(input);
    expect(output).toContain("DIAGMARKER1234");
    expect(output).not.toContain("opaque");
  });

  it("redacts a JSON secret value that contains an escaped quote", () => {
    // The value holds an escaped quote, so a naive matcher stops at the `\"` and
    // leaves the rest of the credential. The marker sits after the escaped quote.
    const input = '{"token":"pre\\"MARKERQUOTE_A"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERQUOTE_A");
    expect(output).toContain(`"token":"${REDACTED_COMMAND_TEXT_VALUE}"`);
  });

  it("redacts a JSON secret value that contains an escaped backslash", () => {
    const input = '{"secret":"pre\\\\MARKERBACKSLASH_A"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERBACKSLASH_A");
    expect(output).toContain(`"secret":"${REDACTED_COMMAND_TEXT_VALUE}"`);
  });

  it("redacts an escaped-JSON secret value that contains an escaped quote", () => {
    // A diagnostic can carry a serialized JSON string, so the whole JSON is
    // escaped a second time. The inner value still holds an escaped quote.
    const innerJson = '{"token":"pre\\"MARKERQUOTE_B"}';
    const input = JSON.stringify(innerJson);
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERQUOTE_B");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an escaped-JSON secret value that contains an escaped backslash", () => {
    const innerJson = '{"password":"pre\\\\MARKERBACKSLASH_B"}';
    const input = JSON.stringify(innerJson);
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERBACKSLASH_B");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });
});

describe("redactCommandText on long runs", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

  function redactWithinTimeBudget(input: string) {
    const startedAt = performance.now();
    const output = redactCommandText(input);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    return output;
  }

  it("keeps redacting options, assignments, and tokens inside dash-separated runs", () => {
    const cases = [
      ["x--token flag-secret", `x--token ${REDACTED_COMMAND_TEXT_VALUE}`],
      ["--x--token flag-secret", `--x--token ${REDACTED_COMMAND_TEXT_VALUE}`],
      [
        "a-b--api-key=assigned-secret --password 'quoted-secret'",
        `a-b--api-key=${REDACTED_COMMAND_TEXT_VALUE} --password '${REDACTED_COMMAND_TEXT_VALUE}'`,
      ],
      ["prefix-MY_API_KEY=env-secret", `prefix-MY_API_KEY=${REDACTED_COMMAND_TEXT_VALUE}`],
      [`--${jwt}`, `--${REDACTED_COMMAND_TEXT_VALUE}`],
      [`session=${jwt}`, `session=${REDACTED_COMMAND_TEXT_VALUE}`],
      ["my-token is here", "my-token is here"],
    ];

    for (const [input, expected] of cases) {
      expect(redactCommandText(input)).toBe(expected);
    }
  });

  it("scans long letter/digit and dash-separated runs in linear time", () => {
    const base64Url = Buffer.from(Array.from({ length: 90_000 }, (_, index) => (index * 7919) % 256)).toString("base64url");
    for (const run of ["a".repeat(120_000), "a-".repeat(60_000), "a--".repeat(40_000), base64Url]) {
      expect(redactWithinTimeBudget(`${run} --token run-secret`)).toBe(`${run} --token ${REDACTED_COMMAND_TEXT_VALUE}`);
      expect(redactWithinTimeBudget(`${run}--token run-secret`)).toBe(`${run}--token ${REDACTED_COMMAND_TEXT_VALUE}`);
    }
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import { redact, redactJson } from "../src/redact.js";

describe("redact", () => {
  it("masks OpenAI-style sk- tokens", () => {
    const out = redact("key sk-proj-ABCDEF0123456789abcdef here");
    expect(out).toContain("sk-<REDACTED>");
    expect(out).not.toContain("ABCDEF0123456789");
  });

  it("masks GitHub tokens", () => {
    expect(redact("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345")).toContain("<REDACTED-GH-TOKEN>");
  });

  it("masks JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redact(jwt)).toContain("<REDACTED-JWT>");
  });

  it("masks values of secret-named JSON fields but keeps the key", () => {
    const out = redact('{"authorization":"Bearer hunter2","token":"abc123","installationId":"9f-uuid"}');
    expect(out).toContain('"authorization":"<REDACTED>"');
    expect(out).toContain('"token":"<REDACTED>"');
    expect(out).toContain('"installationId":"<REDACTED>"');
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abc123");
  });

  it("leaves non-secret content intact", () => {
    const s = '{"method":"turn/completed","status":"completed"}';
    expect(redact(s)).toBe(s);
  });

  it("redactJson round-trips structured values", () => {
    const r = redactJson({ token: "s3cr3t", method: "initialize" }) as Record<string, unknown>;
    expect(r.token).toBe("<REDACTED>");
    expect(r.method).toBe("initialize");
  });
});

describe("redact home path", () => {
  const realHome = process.env.HOME;
  beforeAll(() => {
    // The module captured HOME at import; this test only runs meaningfully when HOME is set.
  });
  it("replaces the home directory with $HOME when set", () => {
    if (!realHome) return;
    expect(redact(`${realHome}/dev/agentdeck`)).toBe("$HOME/dev/agentdeck");
  });
});

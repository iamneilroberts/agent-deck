// Secret redaction for protocol logs and captured transcripts.
// Rule (AGENTS.md): no auth tokens / API keys / secrets and no absolute home paths land in a
// committed capture. This is deliberately conservative — over-redact rather than leak.

const HOME = process.env.HOME ?? "";

/** Redact a single string. */
export function redact(input: string): string {
  let out = input;

  // Field-name-based redaction (keep the key, mask the value).
  out = out.replace(
    /("(?:[a-z0-9_]*(?:token|secret|api[_-]?key|password|authorization|bearer|credential|refresh|installationid)[a-z0-9_]*)"\s*:\s*")([^"]*)(")/gi,
    (_m, k: string, _v: string, q: string) => `${k}<REDACTED>${q}`,
  );

  // Value-shape-based redaction (token-looking strings anywhere).
  out = out.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-<REDACTED>");
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, "<REDACTED-GH-TOKEN>");
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{6,}\b/g, "<REDACTED-JWT>");

  // Home directory -> $HOME (avoid leaking the operator's username/paths).
  if (HOME) out = out.split(HOME).join("$HOME");

  return out;
}

/** Redact a structured value by round-tripping through its JSON string form. */
export function redactJson(value: unknown): unknown {
  try {
    return JSON.parse(redact(JSON.stringify(value)));
  } catch {
    return "<UNSERIALIZABLE>";
  }
}

// NDJSON line framing for the codex app-server stdio transport.
// The server emits one JSON object per '\n'-delimited line, but multiple objects can arrive
// in a single stdout chunk and a single object can be split across chunks. This is a pure,
// testable incremental splitter — feed it chunks, get back complete lines.

export class LineBuffer {
  private acc = "";

  /** Append a chunk and return any newly-completed lines (trailing partial retained). */
  push(chunk: string): string[] {
    this.acc += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.acc.indexOf("\n")) >= 0) {
      const line = this.acc.slice(0, idx);
      this.acc = this.acc.slice(idx + 1);
      // Tolerate CRLF and stray blank lines.
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (trimmed.length > 0) lines.push(trimmed);
    }
    return lines;
  }

  /** Any buffered bytes not yet terminated by a newline. */
  get pending(): string {
    return this.acc;
  }
}

/** Classify a decoded wire message by its structural shape (see proto.ts envelopes). */
export type WireKind = "response" | "serverRequest" | "notification" | "unknown";

export function classify(msg: unknown): WireKind {
  if (typeof msg !== "object" || msg === null) return "unknown";
  const m = msg as Record<string, unknown>;
  const hasId = "id" in m && m.id !== undefined && m.id !== null;
  const hasMethod = typeof m.method === "string";
  if (hasId && hasMethod) return "serverRequest"; // server-initiated request (approvals)
  if (hasId && !hasMethod) return "response"; // reply to one of our requests
  if (!hasId && hasMethod) return "notification"; // streaming event
  return "unknown";
}

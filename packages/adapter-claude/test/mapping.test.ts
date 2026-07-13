import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentEventSchema, type AgentEvent } from "@agentdeck/shared";
import { ClaudeMapper, type ClaudeEventDraft } from "../src/mapping.js";

// Envelope a draft into a full AgentEvent so we can assert it round-trips through the Zod schema —
// the same faithfulness discipline as adapter-codex's mapping test.
function envelope(draft: ClaudeEventDraft): AgentEvent {
  return AgentEventSchema.parse({
    ...draft,
    id: randomUUID(),
    sessionId: randomUUID(),
    sequence: 0,
    timestamp: "2026-07-13T00:00:00.000Z",
    source: "claude",
  } as AgentEvent);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function init(sessionId: string, model = "claude-haiku-4-5-20251001"): any {
  return { type: "system", subtype: "init", session_id: sessionId, model, cwd: "/tmp", tools: [], mcp_servers: [] };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assistant(id: string, content: unknown[]): any {
  return { type: "assistant", message: { id, type: "message", role: "assistant", content }, parent_tool_use_id: null };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function user(content: unknown[]): any {
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

describe("ClaudeMapper", () => {
  it("maps the first system/init to session_started + running, capturing externalSessionId and model", () => {
    const m = new ClaudeMapper();
    const drafts = m.map(init("sess-1", "claude-opus-4-8"));
    expect(drafts).toEqual([
      { type: "session_started", source: "claude", externalSessionId: "sess-1", model: "claude-opus-4-8" },
      { type: "session_status_changed", source: "claude", status: "running" },
    ]);
    drafts.forEach(envelope);
  });

  it("maps a subsequent system/init to running only (session_started fires once per session)", () => {
    const m = new ClaudeMapper();
    m.map(init("sess-1"));
    const drafts = m.map(init("sess-1"));
    expect(drafts).toEqual([{ type: "session_status_changed", source: "claude", status: "running" }]);
  });

  it("maps an assistant text block to a final assistant_message", () => {
    const m = new ClaudeMapper();
    const drafts = m.map(assistant("msg-1", [{ type: "text", text: "hello" }]));
    expect(drafts).toEqual([
      { type: "assistant_message", source: "claude", itemId: "msg-1", text: "hello", phase: "final" },
    ]);
    drafts.forEach(envelope);
  });

  it("maps an assistant thinking block to a final reasoning event", () => {
    const m = new ClaudeMapper();
    const drafts = m.map(assistant("msg-2", [{ type: "thinking", thinking: "pondering" }]));
    expect(drafts).toEqual([
      { type: "reasoning", source: "claude", itemId: "msg-2", text: "pondering", phase: "final" },
    ]);
    drafts.forEach(envelope);
  });

  it("maps an assistant tool_use block to tool_started", () => {
    const m = new ClaudeMapper();
    const drafts = m.map(
      assistant("msg-3", [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } }]),
    );
    expect(drafts).toEqual([
      { type: "tool_started", source: "claude", toolCallId: "tool-1", toolName: "Bash", input: { command: "ls" } },
    ]);
    drafts.forEach(envelope);
  });

  it("maps a user tool_result to tool_output with ok reflecting is_error", () => {
    const m = new ClaudeMapper();
    const ok = m.map(user([{ type: "tool_result", tool_use_id: "tool-1", content: "out", is_error: false }]));
    expect(ok).toEqual([{ type: "tool_output", source: "claude", toolCallId: "tool-1", output: "out", ok: true }]);
    const bad = m.map(user([{ type: "tool_result", tool_use_id: "tool-2", content: "boom", is_error: true }]));
    expect(bad).toEqual([{ type: "tool_output", source: "claude", toolCallId: "tool-2", output: "boom", ok: false }]);
    ok.forEach(envelope);
    bad.forEach(envelope);
  });

  it("maps a successful result to session_status_changed(completed)", () => {
    const m = new ClaudeMapper();
    const drafts = m.map({ type: "result", subtype: "success", is_error: false, result: "done" } as never);
    expect(drafts).toEqual([{ type: "session_status_changed", source: "claude", status: "completed" }]);
    drafts.forEach(envelope);
  });

  it("maps an error result to an error event + failed", () => {
    const m = new ClaudeMapper();
    const drafts = m.map({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["hit cap"] } as never);
    expect(drafts).toEqual([
      { type: "error", source: "claude", message: "hit cap", recoverable: false },
      { type: "session_status_changed", source: "claude", status: "failed" },
    ]);
    drafts.forEach(envelope);
  });

  it("emits nothing for noise messages (status, thinking_tokens, rate_limit, stream_event)", () => {
    const m = new ClaudeMapper();
    expect(m.map({ type: "system", subtype: "status", status: "requesting" } as never)).toEqual([]);
    expect(m.map({ type: "system", subtype: "thinking_tokens" } as never)).toEqual([]);
    expect(m.map({ type: "rate_limit_event" } as never)).toEqual([]);
    expect(m.map({ type: "stream_event", event: { type: "content_block_delta" } } as never)).toEqual([]);
  });

  it("maps a real captured turn (turn-streaming.jsonl) faithfully; every draft round-trips the schema", () => {
    const path = fileURLToPath(new URL("./fixtures/turn-streaming.jsonl", import.meta.url));
    const messages = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    const m = new ClaudeMapper();
    const drafts = messages.flatMap((msg) => m.map(msg));

    // session_started emitted exactly once even though the fixture has 2 system/init messages.
    expect(drafts.filter((d) => d.type === "session_started")).toHaveLength(1);
    // 2 turns => 2 running + 2 completed.
    expect(drafts.filter((d) => d.type === "session_status_changed" && d.status === "running")).toHaveLength(2);
    expect(drafts.filter((d) => d.type === "session_status_changed" && d.status === "completed")).toHaveLength(2);
    // The fixture ran a Bash tool (auto-approved) => at least one tool_started + tool_output.
    expect(drafts.filter((d) => d.type === "tool_started").length).toBeGreaterThanOrEqual(1);
    expect(drafts.filter((d) => d.type === "tool_output").length).toBeGreaterThanOrEqual(1);
    // Every draft is a valid AgentEvent once enveloped.
    drafts.forEach(envelope);
  });
});

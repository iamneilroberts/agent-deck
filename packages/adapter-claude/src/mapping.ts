// Pure mapping from Claude Agent SDK messages to normalized AgentEvent drafts (ADR-0001: the
// adapter is a faithful transport — never invents an event the SDK didn't produce). Mirrors
// adapter-codex's CodexMapper. Built against real captured messages (test/fixtures/*.jsonl).
//
// The mapper is stateful only to the extent the SDK forces it: `session_started` must fire once
// per AgentDeck session, but the SDK emits a fresh `system/init` at the start of EVERY turn (even
// in streaming-input mode). So we track whether we've already announced the session.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@agentdeck/shared";

/** A draft event: everything the mapper knows, minus the fields the event store stamps server-side. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type ClaudeEventDraft = DistributiveOmit<AgentEvent, "id" | "sessionId" | "sequence" | "timestamp">;

const SOURCE = "claude" as const;

/** Content blocks we care about, narrowed from the SDK's message content arrays. */
interface TextBlock {
  type: "text";
  text: string;
}
interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input?: unknown;
}
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

export class ClaudeMapper {
  private sessionStarted = false;

  map(msg: SDKMessage): ClaudeEventDraft[] {
    switch (msg.type) {
      case "system":
        return msg.subtype === "init" ? this.mapInit(msg) : [];
      case "assistant":
        return this.mapAssistant(msg);
      case "user":
        return this.mapUser(msg);
      case "result":
        return this.mapResult(msg);
      // Everything else (system/status, thinking_tokens, rate_limit_event, stream_event, session
      // state pings, hook noise, …) is not part of the normalized stream — never guess.
      default:
        return [];
    }
  }

  private mapInit(msg: Extract<SDKMessage, { type: "system"; subtype: "init" }>): ClaudeEventDraft[] {
    const drafts: ClaudeEventDraft[] = [];
    if (!this.sessionStarted) {
      this.sessionStarted = true;
      drafts.push({ type: "session_started", source: SOURCE, externalSessionId: msg.session_id, model: msg.model });
    }
    // A fresh init means a turn is beginning — the session is running again.
    drafts.push({ type: "session_status_changed", source: SOURCE, status: "running" });
    return drafts;
  }

  private mapAssistant(msg: Extract<SDKMessage, { type: "assistant" }>): ClaudeEventDraft[] {
    const content = msg.message.content;
    if (!Array.isArray(content)) return [];
    const messageId = msg.message.id;
    const multi = content.length > 1;
    const drafts: ClaudeEventDraft[] = [];
    content.forEach((raw, index) => {
      const block = raw as { type?: string };
      const itemId = multi ? `${messageId}:${index}` : messageId;
      if (block.type === "text") {
        drafts.push({ type: "assistant_message", source: SOURCE, itemId, text: (raw as TextBlock).text, phase: "final" });
      } else if (block.type === "thinking") {
        drafts.push({ type: "reasoning", source: SOURCE, itemId, text: (raw as ThinkingBlock).thinking, phase: "final" });
      } else if (block.type === "tool_use") {
        const t = raw as ToolUseBlock;
        drafts.push({ type: "tool_started", source: SOURCE, toolCallId: t.id, toolName: t.name, input: t.input });
      }
      // redacted_thinking, server_tool_use, etc. are not surfaced — faithful silence over guessing.
    });
    return drafts;
  }

  private mapUser(msg: Extract<SDKMessage, { type: "user" }>): ClaudeEventDraft[] {
    const content = msg.message.content;
    if (!Array.isArray(content)) return [];
    const drafts: ClaudeEventDraft[] = [];
    for (const raw of content) {
      const block = raw as { type?: string };
      if (block.type === "tool_result") {
        const tr = raw as ToolResultBlock;
        drafts.push({ type: "tool_output", source: SOURCE, toolCallId: tr.tool_use_id, output: tr.content, ok: !tr.is_error });
      }
    }
    return drafts;
  }

  private mapResult(msg: Extract<SDKMessage, { type: "result" }>): ClaudeEventDraft[] {
    if (msg.subtype === "success" && !msg.is_error) {
      return [{ type: "session_status_changed", source: SOURCE, status: "completed" }];
    }
    const message =
      "errors" in msg && Array.isArray(msg.errors) && msg.errors.length > 0
        ? msg.errors.join("; ")
        : `Claude run ended: ${msg.subtype}`;
    return [
      { type: "error", source: SOURCE, message, recoverable: false },
      { type: "session_status_changed", source: SOURCE, status: "failed" },
    ];
  }
}

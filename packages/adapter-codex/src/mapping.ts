// Pure mapping: a Codex app-server server-notification -> zero or more normalized AgentEvent
// DRAFTS. A draft is an AgentEvent minus the envelope (`id`/`sessionId`/`sequence`/`timestamp`) —
// the adapter's `emit` stamps those + validates, exactly as FakeAdapter does (design §3). Keeping
// this pure + envelope-free makes the mapping table deterministic and fixture-testable.
//
// Built against REAL captured notifications (test/fixtures/turn-notifications.jsonl), NOT inferred
// field names — see docs/design/codex-approval-matrix.md provenance note. Approvals are server
// REQUESTS, not notifications; they live in the approvals bridge, not here.
//
// Deliberate mapping choices (Opus-locked):
//  - agentMessage.phase "final_answer" -> assistant_message; "commentary" -> reasoning (keeps the
//    final answer clean vs the model's narration). Deltas carry only itemId, so we track
//    itemId -> phase from item/started to route each delta.
//  - commandExecution output arrives whole as aggregatedOutput on completion (no streaming
//    notification observed) -> one command_output (stream "merged") then command_completed.
//  - fileChange applied edits surface on item/completed, one file_changed per change.
//  - session_status_changed drafts are emitted as intents; the adapter's emit COALESCES them
//    against the live status (skip no-op/illegal) rather than throwing (design §6).
//  - Unknown item types / unhandled methods -> emit nothing (never guess), design §8.1.
import type { AgentEvent } from "@agentdeck/shared";
import type { WireServerNotification } from "./proto.js";

/** An AgentEvent without the envelope fields the adapter stamps. Distributes over the union. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type CodexEventDraft = DistributiveOmit<AgentEvent, "id" | "sessionId" | "sequence" | "timestamp">;

interface AgentMessageItem {
  type: "agentMessage";
  id: string;
  text?: string;
  phase?: string;
}
interface CommandExecutionItem {
  type: "commandExecution";
  id: string;
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
}
interface FileChangeItem {
  type: "fileChange";
  id: string;
  changes?: Array<{ path: string; kind?: { type?: string }; diff?: string }>;
}
interface UserMessageItem {
  type: "userMessage";
  id: string;
  content?: Array<{ type?: string; text?: string }>;
}

const FILE_KIND_TO_CHANGE: Record<string, "added" | "modified" | "deleted"> = {
  add: "added",
  update: "modified",
  delete: "deleted",
};

/**
 * One mapper per session — holds only the bookkeeping the Codex stream requires: the current
 * turnId (for `interrupt`) and each streaming agentMessage's phase (deltas don't carry it).
 */
export class CodexMapper {
  private turnIdValue: string | null = null;
  private readonly agentMessagePhase = new Map<string, string>();

  /** The most recent turn id seen (null before any turn/started). Needed for `interrupt`. */
  get turnId(): string | null {
    return this.turnIdValue;
  }

  map(n: WireServerNotification): CodexEventDraft[] {
    switch (n.method) {
      case "turn/started": {
        const p = n.params as { turn?: { id?: string } };
        if (p.turn?.id) this.turnIdValue = p.turn.id;
        // Intent: the session is now running (adapter coalesces against live status).
        return [{ type: "session_status_changed", source: "agentdeck", status: "running" }];
      }

      case "turn/completed": {
        const p = n.params as { turn?: { status?: string; error?: unknown } };
        const status = p.turn?.status;
        const out: CodexEventDraft[] = [];
        if (p.turn?.error != null) {
          out.push({ type: "error", source: "codex", message: describeError(p.turn.error), recoverable: false });
          out.push({ type: "session_status_changed", source: "agentdeck", status: "failed" });
        } else if (status === "interrupted") {
          out.push({ type: "session_status_changed", source: "agentdeck", status: "paused" });
        } else {
          out.push({ type: "session_status_changed", source: "agentdeck", status: "completed" });
        }
        return out;
      }

      case "item/agentMessage/delta": {
        const p = n.params as { itemId?: string; delta?: string };
        if (!p.itemId || typeof p.delta !== "string") return [];
        return [this.agentText(p.itemId, p.delta, "delta")];
      }

      case "item/started":
        return this.mapItem(n, "started");

      case "item/completed":
        return this.mapItem(n, "completed");

      case "error": {
        // Thread-level error notification (proven method name; shape best-effort).
        const p = n.params as { message?: string };
        return [
          { type: "error", source: "codex", message: p.message ?? "codex error", recoverable: true },
          { type: "session_status_changed", source: "agentdeck", status: "failed" },
        ];
      }

      default:
        // thread/started, thread/status/changed, mcpServer/*, tokenUsage, rateLimits,
        // turn/diff/updated, remoteControl/* — no normalized event (design §8.1: never guess).
        return [];
    }
  }

  private mapItem(n: WireServerNotification, lifecycle: "started" | "completed"): CodexEventDraft[] {
    const item = (n.params as { item?: { type?: string } }).item;
    if (!item?.type) return [];

    switch (item.type) {
      case "userMessage": {
        if (lifecycle !== "started") return []; // one event per message; use the start
        const text = ((item as UserMessageItem).content ?? [])
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("");
        return text ? [{ type: "user_message", source: "codex", text }] : [];
      }

      case "agentMessage": {
        const m = item as AgentMessageItem;
        if (lifecycle === "started") {
          if (m.phase) this.agentMessagePhase.set(m.id, m.phase);
          return []; // text arrives via deltas / the completed final form
        }
        // completed: the consolidated final form (phase is on the item itself here).
        this.agentMessagePhase.delete(m.id);
        return typeof m.text === "string" && m.text.length > 0
          ? [this.agentText(m.id, m.text, "final", m.phase)]
          : [];
      }

      case "commandExecution": {
        const c = item as CommandExecutionItem;
        if (lifecycle === "started") {
          return [{ type: "command_started", source: "codex", commandId: c.id, command: c.command ?? "", cwd: c.cwd }];
        }
        const out: CodexEventDraft[] = [];
        if (typeof c.aggregatedOutput === "string" && c.aggregatedOutput.length > 0) {
          out.push({ type: "command_output", source: "codex", commandId: c.id, chunk: c.aggregatedOutput, stream: "merged" });
        }
        out.push({
          type: "command_completed",
          source: "codex",
          commandId: c.id,
          exitCode: c.exitCode ?? null,
          durationMs: c.durationMs ?? undefined,
        });
        return out;
      }

      case "fileChange": {
        if (lifecycle !== "completed") return []; // the applied edit is the completed form
        const changes = (item as FileChangeItem).changes ?? [];
        return changes.map((ch): CodexEventDraft => ({
          type: "file_changed",
          source: "codex",
          path: ch.path,
          changeType: FILE_KIND_TO_CHANGE[ch.kind?.type ?? ""] ?? "modified",
          diff: ch.diff,
        }));
      }

      default:
        return []; // unknown item type: never guess (design §8.1)
    }
  }

  /** agentMessage phase "commentary" -> reasoning; "final_answer" (or unknown) -> assistant_message. */
  private agentText(itemId: string, text: string, streamPhase: "delta" | "final", knownPhase?: string): CodexEventDraft {
    const phase = knownPhase ?? this.agentMessagePhase.get(itemId);
    if (phase === "commentary") {
      return { type: "reasoning", source: "codex", itemId, text, phase: streamPhase };
    }
    return { type: "assistant_message", source: "codex", itemId, text, phase: streamPhase };
  }
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return JSON.stringify(error);
}

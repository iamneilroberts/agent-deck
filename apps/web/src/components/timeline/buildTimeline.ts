// Pure fold from the raw AgentEvent stream (ordered by sequence) into display-ready timeline
// items: assistant/reasoning deltas concatenate into one growing item per itemId (replaced
// wholesale when the `final` phase arrives), and command_started/command_output/
// command_completed collapse into one item per commandId. Everything else is 1:1 with its
// event. No React here — this is the part component tests exercise directly.
import type { AgentEvent, ApprovalRequest } from "@agentdeck/shared";

export interface MessageItem {
  kind: "assistant_message" | "reasoning" | "user_message";
  id: string;
  text: string;
  complete: boolean;
  timestamp: string;
}

export interface CommandOutputChunk {
  stream: "stdout" | "stderr" | "merged";
  chunk: string;
}

export interface CommandItem {
  kind: "command";
  id: string;
  command: string;
  cwd?: string;
  output: CommandOutputChunk[];
  exitCode?: number | null;
  durationMs?: number;
  running: boolean;
  timestamp: string;
}

export interface FileChangedItem {
  kind: "file_changed";
  id: string;
  path: string;
  changeType: "added" | "modified" | "deleted";
  diff?: string;
  timestamp: string;
}

export interface ApprovalItem {
  kind: "approval_requested";
  id: string;
  request: ApprovalRequest;
  timestamp: string;
}

export interface TestResultItem {
  kind: "test_result";
  id: string;
  passed: number;
  failed: number;
  total?: number;
  summary?: string;
  timestamp: string;
}

export interface ArtifactItem {
  kind: "artifact_created";
  id: string;
  artifactType: "screenshot" | "trace" | "report" | "video" | "log" | "other";
  path: string;
  mimeType?: string;
  timestamp: string;
}

export interface ErrorItem {
  kind: "error";
  id: string;
  message: string;
  recoverable?: boolean;
  timestamp: string;
}

/** session_started, session_status_changed, tool_started, tool_output, user_input_requested. */
export interface GenericItem {
  kind: "generic";
  id: string;
  event: AgentEvent;
  timestamp: string;
}

export type TimelineItem =
  | MessageItem
  | CommandItem
  | FileChangedItem
  | ApprovalItem
  | TestResultItem
  | ArtifactItem
  | ErrorItem
  | GenericItem;

export function buildTimeline(events: readonly AgentEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const indexByKey = new Map<string, number>();

  for (const event of events) {
    switch (event.type) {
      case "assistant_message":
      case "reasoning": {
        const key = `${event.type}:${event.itemId}`;
        const existingIdx = indexByKey.get(key);
        const existing = existingIdx === undefined ? undefined : items[existingIdx];
        if (existing && existing.kind === event.type) {
          existing.text = event.phase === "final" ? event.text : existing.text + event.text;
          existing.complete = existing.complete || event.phase === "final";
          existing.timestamp = event.timestamp;
        } else {
          items.push({
            kind: event.type,
            id: event.itemId,
            text: event.text,
            complete: event.phase === "final",
            timestamp: event.timestamp,
          });
          indexByKey.set(key, items.length - 1);
        }
        break;
      }
      case "user_message":
        items.push({
          kind: "user_message",
          id: event.id,
          text: event.text,
          complete: true,
          timestamp: event.timestamp,
        });
        break;
      case "command_started": {
        const key = `command:${event.commandId}`;
        items.push({
          kind: "command",
          id: event.commandId,
          command: event.command,
          cwd: event.cwd,
          output: [],
          running: true,
          timestamp: event.timestamp,
        });
        indexByKey.set(key, items.length - 1);
        break;
      }
      case "command_output": {
        const idx = indexByKey.get(`command:${event.commandId}`);
        const item = idx === undefined ? undefined : items[idx];
        if (item && item.kind === "command") {
          item.output.push({ stream: event.stream, chunk: event.chunk });
        }
        break;
      }
      case "command_completed": {
        const idx = indexByKey.get(`command:${event.commandId}`);
        const item = idx === undefined ? undefined : items[idx];
        if (item && item.kind === "command") {
          item.exitCode = event.exitCode ?? null;
          item.durationMs = event.durationMs;
          item.running = false;
          item.timestamp = event.timestamp;
        }
        break;
      }
      case "file_changed":
        items.push({
          kind: "file_changed",
          id: event.id,
          path: event.path,
          changeType: event.changeType,
          diff: event.diff,
          timestamp: event.timestamp,
        });
        break;
      case "approval_requested":
        items.push({
          kind: "approval_requested",
          id: event.id,
          request: event.request,
          timestamp: event.timestamp,
        });
        break;
      case "test_result":
        items.push({
          kind: "test_result",
          id: event.id,
          passed: event.passed,
          failed: event.failed,
          total: event.total,
          summary: event.summary,
          timestamp: event.timestamp,
        });
        break;
      case "artifact_created":
        items.push({
          kind: "artifact_created",
          id: event.id,
          artifactType: event.artifactType,
          path: event.path,
          mimeType: event.mimeType,
          timestamp: event.timestamp,
        });
        break;
      case "error":
        items.push({
          kind: "error",
          id: event.id,
          message: event.message,
          recoverable: event.recoverable,
          timestamp: event.timestamp,
        });
        break;
      default:
        items.push({ kind: "generic", id: event.id, event, timestamp: event.timestamp });
    }
  }

  return items;
}

import type { AgentEvent, ApprovalOption } from "@agentdeck/shared";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString().padStart(12, "0")}`;
}

function base(overrides: { sequence: number; source?: AgentEvent["source"] }) {
  return {
    id: nextId(),
    sessionId: SESSION_ID,
    timestamp: new Date(2026, 0, 1, 0, 0, overrides.sequence).toISOString(),
    source: overrides.source ?? "claude",
    sequence: overrides.sequence,
  } as const;
}

export function assistantDelta(sequence: number, itemId: string, text: string): AgentEvent {
  return { ...base({ sequence }), type: "assistant_message", itemId, text, phase: "delta" };
}

export function assistantFinal(sequence: number, itemId: string, text: string): AgentEvent {
  return { ...base({ sequence }), type: "assistant_message", itemId, text, phase: "final" };
}

export function userMessage(sequence: number, text: string): AgentEvent {
  return { ...base({ sequence }), type: "user_message", text };
}

export function reasoningDelta(sequence: number, itemId: string, text: string): AgentEvent {
  return { ...base({ sequence }), type: "reasoning", itemId, text, phase: "delta" };
}

export function commandStarted(sequence: number, commandId: string, command: string): AgentEvent {
  return { ...base({ sequence }), type: "command_started", commandId, command, cwd: "/repo" };
}

export function commandOutput(sequence: number, commandId: string, chunk: string): AgentEvent {
  return { ...base({ sequence }), type: "command_output", commandId, chunk, stream: "stdout" };
}

export function commandCompleted(sequence: number, commandId: string, exitCode: number): AgentEvent {
  return { ...base({ sequence }), type: "command_completed", commandId, exitCode, durationMs: 42 };
}

export function fileChanged(sequence: number, path: string): AgentEvent {
  return { ...base({ sequence }), type: "file_changed", path, changeType: "modified" };
}

export function testResult(sequence: number, passed: number, failed: number): AgentEvent {
  return { ...base({ sequence }), type: "test_result", passed, failed, total: passed + failed };
}

export function artifactCreated(sequence: number, path: string): AgentEvent {
  return { ...base({ sequence }), type: "artifact_created", artifactType: "screenshot", path };
}

export function errorEvent(sequence: number, message: string): AgentEvent {
  return { ...base({ sequence }), type: "error", message, recoverable: false };
}

export function approvalRequested(
  sequence: number,
  requestId: string,
  options: ApprovalOption[] = [
    { id: "accept", label: "Approve", kind: "allow" },
    { id: "deny", label: "Deny", kind: "deny" },
  ],
): AgentEvent {
  return {
    ...base({ sequence }),
    type: "approval_requested",
    request: {
      requestId,
      kind: "command",
      summary: "Run `rm -rf build`",
      cwd: "/repo",
      reason: "cleanup before build",
      options,
    },
  };
}

export function sessionStarted(sequence: number): AgentEvent {
  return { ...base({ sequence }), type: "session_started", title: "Fix bug", model: "gpt-5" };
}

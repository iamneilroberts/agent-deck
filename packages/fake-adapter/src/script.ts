// The deterministic scripted event stream a FakeAdapter session plays out. No `Math.random()`,
// no branching on wall-clock — every run of PHASE_ONE / PHASE_TWO produces the same sequence of
// event *shapes* (type + fields) every time, so tests can assert exact streams. `id`/`timestamp`
// are stamped by the adapter at emit time (real time by default, injectable for tests); the
// `sequence` field is always 0 here — the store owns sequence assignment (see FakeAdapter doc).
import type { AgentEvent, AgentKind } from "@agentdeck/shared";

/** Plain `Omit` doesn't distribute over a union — this does, so each step keeps its own fields. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export type ScriptEvent = DistributiveOmit<AgentEvent, "id" | "sessionId" | "sequence" | "timestamp">;

export interface ScriptContext {
  readonly sessionId: string;
  readonly externalSessionId: string;
  readonly workingDirectory: string;
  readonly kind: AgentKind;
}

export type ScriptStep = (ctx: ScriptContext) => ScriptEvent;

export const APPROVAL_REQUEST_ID = "fake-approval-1";

export const APPROVAL_OPTIONS = [
  { id: "accept", label: "Allow", kind: "allow" as const },
  { id: "accept_always", label: "Allow for this session", kind: "allow_always" as const },
  { id: "deny", label: "Deny", kind: "deny" as const },
];

/** session_started -> assistant deltas+final -> a command -> pauses on an approval request. */
export const PHASE_ONE: readonly ScriptStep[] = [
  (ctx) => ({
    type: "session_started",
    source: ctx.kind,
    title: "Fake session",
    model: "fake-adapter",
    externalSessionId: ctx.externalSessionId,
  }),
  (ctx) => ({ type: "session_status_changed", source: "agentdeck", status: "running", previous: "starting" }),
  (ctx) => ({ type: "assistant_message", source: ctx.kind, itemId: "msg-1", text: "Looking at the repo", phase: "delta" }),
  (ctx) => ({
    type: "assistant_message",
    source: ctx.kind,
    itemId: "msg-1",
    text: "Looking at the repository structure...",
    phase: "delta",
  }),
  (ctx) => ({
    type: "assistant_message",
    source: ctx.kind,
    itemId: "msg-1",
    text: "Looking at the repository structure... found the failing test.",
    phase: "final",
  }),
  (ctx) => ({ type: "command_started", source: ctx.kind, commandId: "cmd-1", command: "npm test", cwd: ctx.workingDirectory }),
  (ctx) => ({ type: "command_output", source: ctx.kind, commandId: "cmd-1", chunk: "Running test suite...\n", stream: "stdout" }),
  (ctx) => ({ type: "command_output", source: ctx.kind, commandId: "cmd-1", chunk: "3 passed, 1 failed\n", stream: "stdout" }),
  (ctx) => ({ type: "command_completed", source: ctx.kind, commandId: "cmd-1", exitCode: 1, durationMs: 120 }),
  (ctx) => ({ type: "session_status_changed", source: "agentdeck", status: "waiting_for_approval", previous: "running" }),
  (ctx) => ({
    type: "approval_requested",
    source: ctx.kind,
    request: {
      requestId: APPROVAL_REQUEST_ID,
      kind: "file_change",
      summary: "Apply a patch to fix the failing test",
      cwd: ctx.workingDirectory,
      options: APPROVAL_OPTIONS,
    },
  }),
];

/** Resumes after `approve()`: more output, a test result, then the session completes. */
export const PHASE_TWO: readonly ScriptStep[] = [
  (ctx) => ({ type: "session_status_changed", source: "agentdeck", status: "running", previous: "waiting_for_approval" }),
  (ctx) => ({ type: "assistant_message", source: ctx.kind, itemId: "msg-2", text: "Applying the fix", phase: "delta" }),
  (ctx) => ({
    type: "assistant_message",
    source: ctx.kind,
    itemId: "msg-2",
    text: "Applying the fix and re-running tests.",
    phase: "final",
  }),
  (ctx) => ({ type: "test_result", source: ctx.kind, passed: 4, failed: 0, total: 4, summary: "All tests passing" }),
  (ctx) => ({ type: "session_status_changed", source: "agentdeck", status: "completed", previous: "running" }),
];

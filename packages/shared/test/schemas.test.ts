import { describe, it, expect } from "vitest";
import { AgentSessionSchema, ProjectSchema } from "../src/domain.js";
import { AgentEventSchema } from "../src/events.js";
import { ApprovalRequestSchema, ApprovalDecisionSchema, isDecisionValidForRequest } from "../src/approvals.js";

const NOW = "2026-07-13T00:00:00.000Z";
const UUID = "00000000-0000-4000-8000-000000000000";

describe("domain schemas", () => {
  it("accepts a valid project and session", () => {
    expect(ProjectSchema.safeParse({ id: UUID, name: "voygent", repositoryPath: "/repo", createdAt: NOW, updatedAt: NOW }).success).toBe(true);
    expect(
      AgentSessionSchema.safeParse({
        id: UUID,
        projectId: UUID,
        agentKind: "codex",
        workingDirectory: "/repo",
        status: "running",
        startedAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown agent kind and a bad status", () => {
    expect(AgentSessionSchema.safeParse({ id: UUID, projectId: UUID, agentKind: "gpt", workingDirectory: "/r", status: "running", startedAt: NOW, updatedAt: NOW }).success).toBe(false);
    expect(AgentSessionSchema.safeParse({ id: UUID, projectId: UUID, agentKind: "codex", workingDirectory: "/r", status: "thinking", startedAt: NOW, updatedAt: NOW }).success).toBe(false);
  });
});

describe("event schema (discriminated union)", () => {
  const base = { id: UUID, sessionId: UUID, sequence: 1, timestamp: NOW, source: "codex" as const };

  it("validates representative event types", () => {
    expect(AgentEventSchema.safeParse({ ...base, type: "assistant_message", itemId: "m1", text: "hi", phase: "delta" }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...base, type: "command_completed", commandId: "c1", exitCode: 0 }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...base, type: "session_status_changed", status: "completed", previous: "running" }).success).toBe(true);
  });

  it("rejects an unknown event type and a missing required field", () => {
    expect(AgentEventSchema.safeParse({ ...base, type: "nonsense" }).success).toBe(false);
    // assistant_message requires itemId + text + phase
    expect(AgentEventSchema.safeParse({ ...base, type: "assistant_message", text: "hi" }).success).toBe(false);
  });

  it("requires a non-negative integer sequence", () => {
    expect(AgentEventSchema.safeParse({ ...base, sequence: -1, type: "user_message", text: "x" }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...base, sequence: 1.5, type: "user_message", text: "x" }).success).toBe(false);
  });
});

describe("approval model", () => {
  const req = ApprovalRequestSchema.parse({
    requestId: "r1",
    kind: "command",
    summary: "rm -rf build",
    options: [
      { id: "accept", label: "Allow once", kind: "allow" },
      { id: "acceptForSession", label: "Allow for session", kind: "allow_always" },
      { id: "cancel", label: "Deny", kind: "deny" },
    ],
  });

  it("requires at least one option (never a silent approver with no choices)", () => {
    expect(ApprovalRequestSchema.safeParse({ requestId: "r", kind: "command", summary: "s", options: [] }).success).toBe(false);
  });

  it("accepts a decision that references an offered option", () => {
    const decision = ApprovalDecisionSchema.parse({ requestId: "r1", optionId: "accept" });
    expect(isDecisionValidForRequest(req, decision)).toBe(true);
  });

  it("rejects a decision that invents an option the agent did not offer", () => {
    const invented = ApprovalDecisionSchema.parse({ requestId: "r1", optionId: "approve_everything_forever" });
    expect(isDecisionValidForRequest(req, invented)).toBe(false);
  });

  it("rejects a decision for the wrong request id", () => {
    const wrong = ApprovalDecisionSchema.parse({ requestId: "other", optionId: "accept" });
    expect(isDecisionValidForRequest(req, wrong)).toBe(false);
  });
});

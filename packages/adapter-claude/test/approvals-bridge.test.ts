import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentEventSchema, isDecisionValidForRequest, type ApprovalRequest } from "@agentdeck/shared";
import { ClaudeApprovalBridge } from "../src/approvals-bridge.js";
import type { ClaudeEventDraft } from "../src/mapping.js";

function collector() {
  const drafts: ClaudeEventDraft[] = [];
  return { drafts, emit: (d: ClaudeEventDraft) => drafts.push(d) };
}

function requestFrom(drafts: ClaudeEventDraft[]): ApprovalRequest {
  const d = drafts.find((x) => x.type === "approval_requested");
  if (!d || d.type !== "approval_requested") throw new Error("no approval_requested draft");
  return d.request;
}

describe("ClaudeApprovalBridge", () => {
  it("emits a command approval for Bash, offers allow+deny, and parks a promise", async () => {
    const bridge = new ClaudeApprovalBridge();
    const { drafts, emit } = collector();
    const p = bridge.request("Bash", { command: "rm -rf build" }, {}, emit);
    expect(bridge.pendingCount).toBe(1);
    const req = requestFrom(drafts);
    expect(req.kind).toBe("command");
    expect(req.summary).toContain("rm -rf build");
    expect(req.options.map((o) => o.kind).sort()).toEqual(["allow", "deny"]);
    // faithful: the request round-trips the schema
    AgentEventSchema.parse({ ...drafts[0], id: randomUUID(), sessionId: randomUUID(), sequence: 0, timestamp: "2026-07-13T00:00:00.000Z" });

    bridge.resolve({ requestId: req.requestId, optionId: "allow" });
    await expect(p).resolves.toEqual({ behavior: "allow", updatedInput: { command: "rm -rf build" } });
    expect(bridge.pendingCount).toBe(0);
  });

  it("allows with edited input when the decision carries updatedInput", async () => {
    const bridge = new ClaudeApprovalBridge();
    const { drafts, emit } = collector();
    const p = bridge.request("Bash", { command: "ls" }, {}, emit);
    const req = requestFrom(drafts);
    bridge.resolve({ requestId: req.requestId, optionId: "allow", updatedInput: { command: "ls -la" } });
    await expect(p).resolves.toEqual({ behavior: "allow", updatedInput: { command: "ls -la" } });
  });

  it("denies with the user's note as the message", async () => {
    const bridge = new ClaudeApprovalBridge();
    const { drafts, emit } = collector();
    const p = bridge.request("Bash", { command: "curl evil" }, {}, emit);
    const req = requestFrom(drafts);
    bridge.resolve({ requestId: req.requestId, optionId: "deny", note: "no network" });
    await expect(p).resolves.toEqual({ behavior: "deny", message: "no network" });
  });

  it("classifies Edit/Write as file_change and other tools as tool", () => {
    const bridge = new ClaudeApprovalBridge();
    const a = collector();
    bridge.request("Edit", { file_path: "/repo/a.ts" }, {}, a.emit);
    expect(requestFrom(a.drafts).kind).toBe("file_change");

    const b = collector();
    bridge.request("WebFetch", { url: "https://x" }, {}, b.emit);
    expect(requestFrom(b.drafts).kind).toBe("tool");
  });

  it("offers an allow_always option when the SDK supplies permission suggestions", async () => {
    const bridge = new ClaudeApprovalBridge();
    const { drafts, emit } = collector();
    const suggestions = [
      { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" },
    ] as unknown as import("@anthropic-ai/claude-agent-sdk").PermissionUpdate[];
    const p = bridge.request("Bash", { command: "ls" }, { suggestions }, emit);
    const req = requestFrom(drafts);
    expect(req.options.some((o) => o.kind === "allow_always")).toBe(true);
    expect(isDecisionValidForRequest(req, { requestId: req.requestId, optionId: "allow_always" })).toBe(true);
    bridge.resolve({ requestId: req.requestId, optionId: "allow_always" });
    await expect(p).resolves.toEqual({ behavior: "allow", updatedInput: { command: "ls" }, updatedPermissions: suggestions });
  });

  it("throws when resolving an unknown requestId or an option the request never offered", () => {
    const bridge = new ClaudeApprovalBridge();
    const { drafts, emit } = collector();
    bridge.request("Bash", { command: "ls" }, {}, emit);
    const req = requestFrom(drafts);
    expect(() => bridge.resolve({ requestId: "nope", optionId: "allow" })).toThrow();
    expect(() => bridge.resolve({ requestId: req.requestId, optionId: "made_up" })).toThrow();
    expect(bridge.pendingCount).toBe(1); // still parked
  });

  it("cancelAll resolves every pending request as a clean deny", async () => {
    const bridge = new ClaudeApprovalBridge();
    const { drafts, emit } = collector();
    const p = bridge.request("Bash", { command: "ls" }, {}, emit);
    const req = requestFrom(drafts);
    bridge.cancelAll("session stopped");
    await expect(p).resolves.toEqual({ behavior: "deny", message: "session stopped" });
    expect(bridge.pendingCount).toBe(0);
    expect(bridge.hasPending(req.requestId)).toBe(false);
  });
});

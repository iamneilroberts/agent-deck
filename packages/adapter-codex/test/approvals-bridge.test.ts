import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { CodexApprovalBridge } from "../src/approvals-bridge.js";
import type { CodexEventDraft } from "../src/mapping.js";
import { SERVER_REQUEST_METHODS, FILE_CHANGE_DECISIONS } from "../src/proto.js";
import type { WireServerRequest } from "../src/proto.js";
import { AgentEventSchema, isDecisionValidForRequest } from "@agentdeck/shared";
import type { ApprovalRequest } from "@agentdeck/shared";

/** Envelope a draft and assert it parses as a valid AgentEvent (mirrors mapping.test.ts style). */
function assertValidEvent(draft: CodexEventDraft): void {
  expect(() =>
    AgentEventSchema.parse({
      ...draft,
      id: randomUUID(),
      sessionId: randomUUID(),
      sequence: 0,
      timestamp: new Date().toISOString(),
    }),
  ).not.toThrow();
}

function approvalRequestOf(draft: CodexEventDraft): ApprovalRequest {
  if (draft.type !== "approval_requested") throw new Error(`expected approval_requested, got ${draft.type}`);
  return draft.request;
}

describe("CodexApprovalBridge", () => {
  it("1. command approval: faithful string-decision options, resolves to the chosen decision", async () => {
    const bridge = new CodexApprovalBridge();
    const drafts: CodexEventDraft[] = [];
    const req: WireServerRequest = {
      id: 5,
      method: SERVER_REQUEST_METHODS.commandApproval,
      params: {
        threadId: "t1",
        turnId: "turn1",
        itemId: "item1",
        startedAtMs: 0,
        command: "rm -rf /tmp/x",
        cwd: "/tmp",
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
    };

    const promise = bridge.onServerRequest(req, (d) => drafts.push(d));
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    expect(drafts).toHaveLength(1);
    const draft = drafts[0]!;
    expect(draft.type).toBe("approval_requested");
    const request = approvalRequestOf(draft);
    expect(request.kind).toBe("command");
    expect(request.summary).toContain("rm -rf /tmp/x");
    expect(request.cwd).toBe("/tmp");
    expect(request.options.map((o) => o.id)).toEqual(["accept", "acceptForSession", "decline", "cancel"]);
    expect(request.options.map((o) => o.kind)).toEqual(["allow", "allow_always", "deny", "deny"]);

    await Promise.resolve();
    expect(settled).toBe(false);

    bridge.resolveApproval("5", "accept");
    await expect(promise).resolves.toEqual({ decision: "accept" });
  });

  it("2. command approval: object-decision option id round-trips to the original object", async () => {
    const bridge = new CodexApprovalBridge();
    const drafts: CodexEventDraft[] = [];
    const objectDecision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } };
    const req: WireServerRequest = {
      id: 6,
      method: SERVER_REQUEST_METHODS.commandApproval,
      params: {
        threadId: "t1",
        turnId: "turn1",
        itemId: "item1",
        startedAtMs: 0,
        command: "git status",
        cwd: "/tmp",
        availableDecisions: ["accept", objectDecision, "decline"],
      },
    };

    const promise = bridge.onServerRequest(req, (d) => drafts.push(d));
    const request = approvalRequestOf(drafts[0]!);
    const objectOption = request.options[1]!;
    expect(objectOption.id).toBe(JSON.stringify(objectDecision));
    expect(objectOption.kind).toBe("custom");

    bridge.resolveApproval("6", objectOption.id);
    const result = (await promise) as { decision: unknown };
    expect(result.decision).toEqual(objectDecision);
  });

  it("3. fileChange approval (no availableDecisions): faithful fixed decision set", async () => {
    const bridge = new CodexApprovalBridge();
    const drafts: CodexEventDraft[] = [];
    const req: WireServerRequest = {
      id: 7,
      method: SERVER_REQUEST_METHODS.fileChangeApproval,
      params: {
        threadId: "t1",
        turnId: "turn1",
        itemId: "item1",
        startedAtMs: 0,
        reason: "edit 2 files",
      },
    };

    const promise = bridge.onServerRequest(req, (d) => drafts.push(d));
    const request = approvalRequestOf(drafts[0]!);
    expect(request.options.map((o) => o.id)).toEqual([...FILE_CHANGE_DECISIONS]);

    bridge.resolveApproval("7", "decline");
    await expect(promise).resolves.toEqual({ decision: "decline" });
  });

  it("4. requestUserInput: emits user_input_requested and resolves with keyed answers", async () => {
    const bridge = new CodexApprovalBridge();
    const drafts: CodexEventDraft[] = [];
    const req: WireServerRequest = {
      id: 8,
      method: SERVER_REQUEST_METHODS.requestUserInput,
      params: {
        threadId: "t1",
        turnId: "turn1",
        itemId: "item1",
        questions: [
          { id: "q1", header: "H", question: "Proceed?", isOther: false, isSecret: false, options: null },
        ],
        autoResolutionMs: null,
      },
    };

    const promise = bridge.onServerRequest(req, (d) => drafts.push(d));
    expect(drafts).toHaveLength(1);
    const draft = drafts[0]!;
    expect(draft.type).toBe("user_input_requested");
    if (draft.type !== "user_input_requested") throw new Error("unreachable");
    expect(draft.requestId).toBe("8");
    expect(draft.prompt).toContain("Proceed?");

    bridge.resolveUserInput("8", "yes");
    await expect(promise).resolves.toEqual({ answers: { q1: { answers: ["yes"] } } });
  });

  it("5. unsupported method: emits an error draft and the returned promise rejects", async () => {
    const bridge = new CodexApprovalBridge();
    const drafts: CodexEventDraft[] = [];
    const req: WireServerRequest = {
      id: 9,
      method: SERVER_REQUEST_METHODS.permissionsApproval,
      params: {},
    };

    const promise = bridge.onServerRequest(req, (d) => drafts.push(d));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.type).toBe("error");
    await expect(promise).rejects.toThrow();
  });

  it("6. rejectAll rejects held promises and clears pendingCount", async () => {
    const bridge = new CodexApprovalBridge();
    const req: WireServerRequest = {
      id: 10,
      method: SERVER_REQUEST_METHODS.commandApproval,
      params: {
        threadId: "t1",
        turnId: "turn1",
        itemId: "item1",
        startedAtMs: 0,
        command: "echo hi",
        availableDecisions: ["accept", "decline"],
      },
    };
    const promise = bridge.onServerRequest(req, () => {});
    expect(bridge.pendingCount).toBe(1);

    bridge.rejectAll(new Error("crash"));
    await expect(promise).rejects.toThrow("crash");
    expect(bridge.pendingCount).toBe(0);
  });

  it("7. error cases: unknown requestId, kind mismatches", async () => {
    const bridge = new CodexApprovalBridge();

    expect(() => bridge.resolveApproval("unknown", "accept")).toThrow();
    expect(() => bridge.resolveUserInput("unknown", "yes")).toThrow();

    const userInputReq: WireServerRequest = {
      id: 11,
      method: SERVER_REQUEST_METHODS.requestUserInput,
      params: {
        threadId: "t1",
        turnId: "turn1",
        itemId: "item1",
        questions: [{ id: "q1", header: "H", question: "Q?", isOther: false, isSecret: false, options: null }],
        autoResolutionMs: null,
      },
    };
    const pendingUserInput = bridge.onServerRequest(userInputReq, () => {});
    expect(() => bridge.resolveApproval("11", "accept")).toThrow();
    pendingUserInput.catch(() => {});
    bridge.rejectAll(new Error("cleanup"));

    const approvalReq: WireServerRequest = {
      id: 12,
      method: SERVER_REQUEST_METHODS.commandApproval,
      params: {
        threadId: "t1",
        turnId: "turn1",
        itemId: "item1",
        startedAtMs: 0,
        command: "echo hi",
        availableDecisions: ["accept", "decline"],
      },
    };
    const pendingApproval = bridge.onServerRequest(approvalReq, () => {});
    expect(() => bridge.resolveUserInput("12", "yes")).toThrow();
    pendingApproval.catch(() => {});
    bridge.rejectAll(new Error("cleanup"));
  });

  it("8. faithful + schema: command and fileChange drafts parse as AgentEvents, options are valid decisions", () => {
    const bridge = new CodexApprovalBridge();
    const drafts: CodexEventDraft[] = [];

    const commandReq: WireServerRequest = {
      id: 13,
      method: SERVER_REQUEST_METHODS.commandApproval,
      params: {
        threadId: "t1",
        turnId: "turn1",
        itemId: "item1",
        startedAtMs: 0,
        command: "ls",
        cwd: "/tmp",
        availableDecisions: ["accept", "decline"],
      },
    };
    const commandPromise = bridge.onServerRequest(commandReq, (d) => drafts.push(d));
    commandPromise.catch(() => {});

    const fileChangeReq: WireServerRequest = {
      id: 14,
      method: SERVER_REQUEST_METHODS.fileChangeApproval,
      params: { threadId: "t1", turnId: "turn1", itemId: "item1", startedAtMs: 0, reason: "edit 2 files" },
    };
    const fileChangePromise = bridge.onServerRequest(fileChangeReq, (d) => drafts.push(d));
    fileChangePromise.catch(() => {});

    expect(drafts).toHaveLength(2);
    for (const draft of drafts) {
      assertValidEvent(draft);
      const request = approvalRequestOf(draft);
      for (const option of request.options) {
        expect(
          isDecisionValidForRequest(request, { requestId: request.requestId, optionId: option.id }),
        ).toBe(true);
      }
    }

    bridge.rejectAll(new Error("cleanup"));
  });
});

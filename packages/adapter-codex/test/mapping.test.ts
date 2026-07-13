import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CodexMapper } from "../src/mapping.js";
import type { CodexEventDraft } from "../src/mapping.js";
import type { WireServerNotification } from "../src/proto.js";
import { AgentEventSchema } from "@agentdeck/shared";

function loadFixture(): WireServerNotification[] {
  const raw = readFileSync(new URL("./fixtures/turn-notifications.jsonl", import.meta.url), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as WireServerNotification);
}

function draftsOfType<T extends CodexEventDraft["type"]>(
  drafts: CodexEventDraft[],
  type: T,
): Extract<CodexEventDraft, { type: T }>[] {
  return drafts.filter((d): d is Extract<CodexEventDraft, { type: T }> => d.type === type);
}

describe("CodexMapper against a real captured turn (fixture)", () => {
  const notifications = loadFixture();
  const mapper = new CodexMapper();
  const drafts: CodexEventDraft[] = [];
  for (const n of notifications) {
    drafts.push(...mapper.map(n));
  }

  it("has 62 notifications in the fixture", () => {
    expect(notifications).toHaveLength(62);
  });

  it("emits session_status_changed running (from turn/started) then exactly one completed", () => {
    const statuses = draftsOfType(drafts, "session_status_changed");
    expect(statuses[0]).toMatchObject({ status: "running" });
    const completed = statuses.filter((s) => s.status === "completed");
    expect(completed).toHaveLength(1);
    expect(statuses[statuses.length - 1]).toMatchObject({ status: "completed" });
  });

  it("emits exactly one user_message draft containing the task text", () => {
    const userMessages = draftsOfType(drafts, "user_message");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.text).toContain("Do these three steps");
  });

  it("maps the echo command to started -> output -> completed, in order", () => {
    const started = draftsOfType(drafts, "command_started").find((d) => d.command.includes("echo hello-agentdeck"));
    expect(started).toBeDefined();
    const commandId = started!.commandId;

    const output = draftsOfType(drafts, "command_output").find((d) => d.commandId === commandId);
    expect(output).toBeDefined();
    expect(output!.stream).toBe("merged");
    expect(output!.chunk).toContain("hello-agentdeck");

    const completed = draftsOfType(drafts, "command_completed").find((d) => d.commandId === commandId);
    expect(completed).toBeDefined();
    expect(completed!.exitCode).toBe(0);

    const startedIdx = drafts.indexOf(started!);
    const outputIdx = drafts.indexOf(output!);
    const completedIdx = drafts.indexOf(completed!);
    expect(startedIdx).toBeLessThan(outputIdx);
    expect(outputIdx).toBeLessThan(completedIdx);
  });

  it("maps the note.txt fileChange to a single file_changed (added)", () => {
    const fileChanges = draftsOfType(drafts, "file_changed");
    expect(fileChanges).toHaveLength(1);
    expect(fileChanges[0]!.changeType).toBe("added");
    expect(fileChanges[0]!.path.endsWith("note.txt")).toBe(true);
  });

  it("routes commentary-phase agentMessage deltas to reasoning drafts", () => {
    const reasoning = draftsOfType(drafts, "reasoning");
    // 26 deltas + 1 final form for the commentary item in the fixture.
    expect(reasoning.length).toBeGreaterThan(0);
    for (const r of reasoning) {
      expect(typeof r.text).toBe("string");
    }
  });

  it("routes final_answer agentMessage deltas to assistant_message drafts that concatenate to DONE", () => {
    const assistantMessages = draftsOfType(drafts, "assistant_message");
    const deltaTexts = assistantMessages.filter((d) => d.phase === "delta").map((d) => d.text);
    expect(deltaTexts.join("")).toBe("DONE");
    const finalMessages = assistantMessages.filter((d) => d.phase === "final");
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]!.text).toBe("DONE");
  });

  it("emits no drafts for known noise methods", () => {
    const noiseMethods = new Set([
      "mcpServer/startupStatus/updated",
      "thread/tokenUsage/updated",
      "account/rateLimits/updated",
      "turn/diff/updated",
      "thread/status/changed",
      "thread/started",
      "remoteControl/status/changed",
    ]);
    const noiseMapper = new CodexMapper();
    let noiseDraftCount = 0;
    for (const n of notifications) {
      if (noiseMethods.has(n.method)) {
        noiseDraftCount += noiseMapper.map(n).length;
      }
    }
    expect(noiseDraftCount).toBe(0);
  });

  it("produces exactly the expected total draft count for the whole turn", () => {
    // running(1) + user_message(1) + reasoning deltas(26) + reasoning final(1) + command_started(1)
    // + command_output(1) + command_completed(1) + file_changed(1) + assistant delta(1)
    // + assistant final(1) + completed(1) = 36
    expect(drafts).toHaveLength(36);
  });
});

describe("CodexMapper turn/completed status mapping (hand-built)", () => {
  it("maps turn.status 'interrupted' to session_status_changed 'paused'", () => {
    const mapper = new CodexMapper();
    const n: WireServerNotification = {
      method: "turn/completed",
      params: { threadId: "t1", turn: { id: "turn-1", status: "interrupted" } },
    };
    const out = mapper.map(n);
    expect(out).toEqual([{ type: "session_status_changed", source: "agentdeck", status: "paused" }]);
  });

  it("maps turn.status 'completed' to session_status_changed 'completed'", () => {
    const mapper = new CodexMapper();
    const n: WireServerNotification = {
      method: "turn/completed",
      params: { threadId: "t1", turn: { id: "turn-1", status: "completed" } },
    };
    const out = mapper.map(n);
    expect(out).toEqual([{ type: "session_status_changed", source: "agentdeck", status: "completed" }]);
  });
});

describe("CodexMapper drafts conform to AgentEventSchema once stamped with an envelope", () => {
  it("every draft from the fixture turn parses as a valid AgentEvent", () => {
    const mapper = new CodexMapper();
    const notifications = loadFixture();
    const drafts: CodexEventDraft[] = [];
    for (const n of notifications) {
      drafts.push(...mapper.map(n));
    }
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
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
  });
});

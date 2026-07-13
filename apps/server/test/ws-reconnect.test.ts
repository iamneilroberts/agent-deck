// Drives a REAL listening server with a real `ws` client (not `fastify.inject`), proving the
// reconnect-and-replay guarantees from docs/api-contract.md: replayed sequences are contiguous
// from lastSeq+1 with no gaps/dupes, the live tail resumes at headSequence+1, and a lastSeq at
// (or past) head replays nothing.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { APPROVAL_OPTIONS, APPROVAL_REQUEST_ID } from "@agentdeck/fake-adapter";
import { buildTestServer, loginCookieHeader, waitFor, waitForEventType, type TestServer } from "./helpers.js";

interface ServerMessage {
  type: string;
  event?: { sequence: number; type: string; status?: string };
  headSequence?: number;
  sessionId?: string;
}

/**
 * Buffers every message from the moment the socket is constructed — NOT from whenever the
 * caller happens to attach a listener. This matters: on localhost the server can write its
 * entire reply (hello_ok + all replayed events + replay_complete) into the same TCP read as the
 * upgrade response, so `ws` can emit `open` and every `message` synchronously within one data
 * callback. A listener attached only after `await`-ing `open` (a microtask away) would miss all
 * of it. `collectUntil` instead replays from an already-filled buffer, then waits for more.
 */
class RecordingSocket {
  readonly ws: WebSocket;
  private readonly buffer: ServerMessage[] = [];
  private readonly onMessage = new Set<() => void>();

  constructor(url: string, cookie: string) {
    this.ws = new WebSocket(url, { headers: { cookie } });
    this.ws.on("message", (raw: Buffer) => {
      this.buffer.push(JSON.parse(raw.toString("utf8")) as ServerMessage);
      for (const listener of this.onMessage) listener();
    });
  }

  waitOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  /** Messages from `fromIndex` through (and including) the first one matching `stop`. */
  async collectUntil(
    fromIndex: number,
    stop: (m: ServerMessage) => boolean,
  ): Promise<{ messages: ServerMessage[]; nextIndex: number }> {
    for (;;) {
      for (let i = fromIndex; i < this.buffer.length; i++) {
        const msg = this.buffer[i]!;
        if (stop(msg)) return { messages: this.buffer.slice(fromIndex, i + 1), nextIndex: i + 1 };
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("collectUntil timed out")), 5000);
        const listener = (): void => {
          clearTimeout(timer);
          this.onMessage.delete(listener);
          resolve();
        };
        this.onMessage.add(listener);
      });
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

async function connect(port: number, query: string, cookie: string): Promise<RecordingSocket> {
  const socket = new RecordingSocket(`ws://127.0.0.1:${port}/api/events?${query}`, cookie);
  await socket.waitOpen();
  return socket;
}

describe("WS /api/events reconnect-and-replay", () => {
  let server: TestServer;
  let port: number;
  let cookie: string;

  beforeEach(async () => {
    server = await buildTestServer();
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    port = (server.app.server.address() as AddressInfo).port;
    cookie = await loginCookieHeader(server.app);
  });

  afterEach(async () => {
    await server.app.close();
  });

  async function createSessionAtApprovalPause(): Promise<string> {
    const projectRes = await server.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { name: "WS test project", repositoryPath: "/tmp/agentdeck-ws-test" },
    });
    const project = projectRes.json();
    const sessionRes = await server.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie },
      payload: { projectId: project.id, agentKind: "claude", workingDirectory: "/tmp/agentdeck-ws-test" },
    });
    const session = sessionRes.json();
    // PHASE_ONE pauses deterministically on approval_requested — wait for that exact event
    // rather than the status flip, which can land a tick earlier (see helpers.ts).
    await waitForEventType(server.store, session.id, "approval_requested");
    return session.id as string;
  }

  it("replays contiguous history, resumes the live tail at headSequence+1, fills a reconnect gap with no missing/duplicate sequences, and replays nothing once lastSeq is at/past head", async () => {
    const sessionId = await createSessionAtApprovalPause();

    // 1. First connection: replay from the very start.
    const ws1 = await connect(port, `sessionId=${sessionId}&lastSeq=0`, cookie);
    const { messages: initialFrames, nextIndex: afterReplay1 } = await ws1.collectUntil(
      0,
      (m) => m.type === "replay_complete",
    );
    const helloOk = initialFrames.find((m) => m.type === "hello_ok");
    expect(helloOk?.sessionId).toBe(sessionId);
    const replayComplete1 = initialFrames.at(-1)!;
    expect(replayComplete1.type).toBe("replay_complete");
    const headAtPause = replayComplete1.headSequence!;
    expect(headAtPause).toBe(11); // PHASE_ONE's 11 scripted events, through approval_requested

    const replayedSeqs = initialFrames.filter((m) => m.type === "event").map((m) => m.event!.sequence);
    expect(replayedSeqs).toEqual(Array.from({ length: headAtPause }, (_, i) => i + 1)); // 1..head, contiguous

    // 2. Trigger PHASE_TWO (approve) while ws1 stays connected; its live tail must resume
    //    exactly at headSequence + 1 with no gap and no duplicate of what was already replayed.
    const approveRes = await server.app.inject({
      method: "POST",
      url: `/api/approvals/${APPROVAL_REQUEST_ID}/resolve`,
      headers: { cookie },
      payload: { sessionId, optionId: APPROVAL_OPTIONS[0]?.id },
    });
    expect(approveRes.statusCode).toBe(202);

    const { messages: liveFrames } = await ws1.collectUntil(
      afterReplay1,
      (m) => m.type === "event" && m.event?.type === "session_status_changed" && m.event.status === "completed",
    );
    const liveSeqs = liveFrames.filter((m) => m.type === "event").map((m) => m.event!.sequence);
    const finalHead = await waitFor(() => {
      const head = server.store.getHeadSequence(sessionId);
      return head > headAtPause ? head : undefined;
    });
    expect(liveSeqs).toEqual(Array.from({ length: finalHead - headAtPause }, (_, i) => headAtPause + 1 + i));

    await ws1.close();

    // 3. Reconnect with lastSeq = the sequence the first client had actually seen (headAtPause)
    //    — simulating a drop right before the live tail. The gap must be filled exactly, no
    //    missing and no duplicate sequences relative to what ws1 already received live.
    const ws2 = await connect(port, `sessionId=${sessionId}&lastSeq=${headAtPause}`, cookie);
    const { messages: gapFillFrames } = await ws2.collectUntil(0, (m) => m.type === "replay_complete");
    const gapFillSeqs = gapFillFrames.filter((m) => m.type === "event").map((m) => m.event!.sequence);
    expect(gapFillSeqs).toEqual(liveSeqs);
    const gapFillComplete = gapFillFrames.at(-1)!;
    expect(gapFillComplete.headSequence).toBe(finalHead);
    await ws2.close();

    // 4. lastSeq at (or past) head replays nothing.
    const ws3 = await connect(port, `sessionId=${sessionId}&lastSeq=${finalHead + 100}`, cookie);
    const { messages: nothingFrames } = await ws3.collectUntil(0, (m) => m.type === "replay_complete");
    expect(nothingFrames.filter((m) => m.type === "event")).toHaveLength(0);
    expect(nothingFrames.at(-1)!.headSequence).toBe(finalHead);
    await ws3.close();
  });

  it("rejects a WS upgrade without a valid session cookie", async () => {
    await expect(connect(port, "sessionId=does-not-matter", "agentdeck_session=not-a-real-token")).rejects.toThrow();
  });
});

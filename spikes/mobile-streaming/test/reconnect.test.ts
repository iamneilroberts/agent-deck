import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "../src/server.js";

/**
 * This is the actual proof for Spike C: no browser, a real `ws` client against the real
 * server, asserting the gap-replay and heartbeat contracts end to end.
 */

interface WireEventMessage {
  readonly type: "event";
  readonly event: { readonly sequence: number };
}
interface WireReplayComplete {
  readonly type: "replayComplete";
  readonly headSequence: number;
}
interface WireHeartbeat {
  readonly type: "heartbeat";
  readonly timestamp: number;
}
type WireMessage = WireEventMessage | WireReplayComplete | WireHeartbeat | { readonly type: string };

function isWireMessage(value: unknown): value is WireMessage {
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)["type"] === "string";
}

function onWireMessage(ws: WebSocket, handler: (msg: WireMessage) => void): void {
  ws.on("message", (raw) => {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (isWireMessage(parsed)) handler(parsed);
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitUntil(predicate: () => boolean, timeoutMs = 4000, pollMs = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("waitUntil timed out"));
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

let server: RunningServer;

beforeEach(async () => {
  server = await startServer({ port: 0, intervalMs: 15, heartbeatMs: 40, sessionId: "test-session" });
});

afterEach(async () => {
  await server.stop();
});

describe("reconnect-and-replay", () => {
  it("fills the gap across a forced disconnect with no missing or duplicate sequences, then resumes the live tail", async () => {
    const seenByA: number[] = [];
    const clientA = new WebSocket(server.wsUrl);
    onWireMessage(clientA, (msg) => {
      if (msg.type === "event") seenByA.push((msg as WireEventMessage).event.sequence);
    });
    await waitForOpen(clientA);
    await waitUntil(() => seenByA.length >= 5);

    const lastSeq = seenByA[seenByA.length - 1]!;
    clientA.terminate();

    // Let the server tick several more times while nobody is connected — this is the gap
    // the reconnect must fill exactly.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const replayedSeqs: number[] = [];
    const liveSeqs: number[] = [];
    let replayHeadSequence = -1;
    let replayComplete = false;

    const clientB = new WebSocket(`${server.wsUrl}?lastSeq=${lastSeq}`);
    onWireMessage(clientB, (msg) => {
      if (msg.type === "event") {
        const sequence = (msg as WireEventMessage).event.sequence;
        (replayComplete ? liveSeqs : replayedSeqs).push(sequence);
      } else if (msg.type === "replayComplete") {
        replayHeadSequence = (msg as WireReplayComplete).headSequence;
        replayComplete = true;
      }
    });
    await waitForOpen(clientB);
    await waitUntil(() => replayComplete);

    // The 150ms gap at a 15ms tick interval must have produced something to replay, or this
    // test isn't actually exercising the gap-fill path.
    expect(replayedSeqs.length).toBeGreaterThan(0);

    // Replayed events are exactly contiguous, starting right after the client's lastSeq —
    // no missing sequence numbers, no duplicates.
    const expectedReplayed = Array.from({ length: replayedSeqs.length }, (_, i) => lastSeq + 1 + i);
    expect(replayedSeqs).toEqual(expectedReplayed);
    expect(replayHeadSequence).toBe(replayedSeqs[replayedSeqs.length - 1]);

    // The live tail resumes with no gap and no overlap with what was just replayed.
    await waitUntil(() => liveSeqs.length >= 3);
    const expectedLiveStart = replayHeadSequence + 1;
    for (let i = 0; i < liveSeqs.length; i += 1) {
      expect(liveSeqs[i]).toBe(expectedLiveStart + i);
    }

    // No sequence number appears twice across the whole observed run (pre-disconnect +
    // replayed + live tail).
    const all = [...seenByA, ...replayedSeqs, ...liveSeqs];
    expect(new Set(all).size).toBe(all.length);

    clientB.terminate();
  });

  it("does not replay bogus events when lastSeq is already ahead of the current head", async () => {
    const aheadOfHead = server.store.headSequence + 1_000_000;
    const events: number[] = [];
    let replayHeadSequence = -1;
    let replayComplete = false;

    const client = new WebSocket(`${server.wsUrl}?lastSeq=${aheadOfHead}`);
    onWireMessage(client, (msg) => {
      if (msg.type === "event") events.push((msg as WireEventMessage).event.sequence);
      else if (msg.type === "replayComplete") {
        replayHeadSequence = (msg as WireReplayComplete).headSequence;
        replayComplete = true;
      }
    });
    await waitForOpen(client);
    await waitUntil(() => replayComplete);

    expect(events).toEqual([]); // no bogus replay
    expect(replayHeadSequence).toBe(server.store.headSequence);
    expect(replayHeadSequence).toBeLessThan(aheadOfHead);

    client.terminate();
  });

  it("delivers app-level heartbeats on the configured interval", async () => {
    const heartbeats: number[] = [];
    const client = new WebSocket(server.wsUrl);
    onWireMessage(client, (msg) => {
      if (msg.type === "heartbeat") heartbeats.push((msg as WireHeartbeat).timestamp);
    });
    await waitForOpen(client);
    await waitUntil(() => heartbeats.length >= 1, 1000);

    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    client.terminate();
  });

  it("supports resuming via an in-band hello message, not just the query string", async () => {
    const client = new WebSocket(server.wsUrl); // no ?lastSeq — plain live connection
    const liveSeqs: number[] = [];
    const replayed: number[] = [];
    let helloSent = false;
    let replayComplete = false;
    let replayHeadSequence = -1;

    onWireMessage(client, (msg) => {
      if (msg.type === "event") {
        const sequence = (msg as WireEventMessage).event.sequence;
        if (!helloSent) liveSeqs.push(sequence);
        else if (!replayComplete) replayed.push(sequence);
      } else if (msg.type === "replayComplete" && helloSent) {
        replayHeadSequence = (msg as WireReplayComplete).headSequence;
        replayComplete = true;
      }
    });

    await waitForOpen(client);
    await waitUntil(() => liveSeqs.length >= 2);
    const lastSeq = liveSeqs[0]!;

    helloSent = true;
    client.send(JSON.stringify({ type: "hello", lastSeq }));
    await waitUntil(() => replayComplete);

    const expected = Array.from({ length: replayed.length }, (_, i) => lastSeq + 1 + i);
    expect(replayed).toEqual(expected);
    expect(replayHeadSequence).toBe(lastSeq + replayed.length);

    client.terminate();
  });

  it("rejects a malformed frame without crashing the connection", async () => {
    const errors: string[] = [];
    let sawFollowingEvent = false;

    const client = new WebSocket(server.wsUrl);
    onWireMessage(client, (msg) => {
      if (msg.type === "error") errors.push("error");
      if (msg.type === "event") sawFollowingEvent = true;
    });
    await waitForOpen(client);
    client.send("not json");

    await waitUntil(() => errors.length >= 1);
    await waitUntil(() => sawFollowingEvent); // connection still alive and streaming after the bad frame

    client.terminate();
  });
});

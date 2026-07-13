import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEventsClient, type WebSocketFactory, type WebSocketLike } from "../src/ws/eventsClient";
import { assistantFinal } from "./fixtures/events";

class FakeSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.({});
  }

  open(): void {
    this.onopen?.({});
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

describe("AgentEventsClient reconnect-replay", () => {
  let sockets: FakeSocket[];
  let factory: WebSocketFactory;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    factory = () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends hello with lastSeq=0 on first connect", () => {
    const client = new AgentEventsClient(factory);
    client.start("session-1", 0);
    sockets[0]?.open();

    const hello = JSON.parse(sockets[0]?.sent[0] ?? "{}");
    expect(hello).toEqual({ type: "hello", sessionId: "session-1", lastSeq: 0 });
  });

  it("resumes from the highest applied sequence after a reconnect, with no gap and no duplicate", () => {
    const client = new AgentEventsClient(factory);
    client.start("session-1", 0);
    sockets[0]?.open();
    sockets[0]?.receive({ type: "hello_ok", sessionId: "session-1", headSequence: 2 });
    sockets[0]?.receive({ type: "event", event: assistantFinal(1, "item-1", "hi") });
    sockets[0]?.receive({ type: "event", event: assistantFinal(2, "item-1", "hi there") });
    sockets[0]?.receive({ type: "replay_complete", headSequence: 2 });

    expect(client.getState().lastSeq).toBe(2);
    expect(client.getState().status).toBe("live");

    // Connection drops.
    sockets[0]?.close();
    expect(client.getState().status).toBe("reconnecting");

    // Advance past the first backoff (1s) so the client reconnects.
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);

    sockets[1]?.open();
    const secondHello = JSON.parse(sockets[1]?.sent[0] ?? "{}");
    expect(secondHello).toEqual({ type: "hello", sessionId: "session-1", lastSeq: 2 });

    // Server replays only what's after lastSeq=2 (sequence 3), then continues live.
    sockets[1]?.receive({ type: "hello_ok", sessionId: "session-1", headSequence: 3 });
    sockets[1]?.receive({ type: "event", event: assistantFinal(3, "item-2", "back") });
    sockets[1]?.receive({ type: "replay_complete", headSequence: 3 });

    const state = client.getState();
    expect(state.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(state.lastSeq).toBe(3);
    expect(state.status).toBe("live");
  });

  it("stop() tears down the socket and cancels a pending reconnect", () => {
    const client = new AgentEventsClient(factory);
    client.start("session-1", 0);
    sockets[0]?.open();
    sockets[0]?.close();

    client.stop();
    vi.advanceTimersByTime(20_000);

    expect(sockets).toHaveLength(1); // no reconnect attempted after stop()
  });
});

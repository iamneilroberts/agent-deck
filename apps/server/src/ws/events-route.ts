// GET /api/events — reconnect-and-replay live event bus (docs/api-contract.md). Replay is done
// entirely with synchronous EventStore reads (better-sqlite3), and the hub subscription is only
// opened *after* the replay is fully sent — so no live event can land in the gap between "what
// the replay covered" and "what the live tail starts from", and headSequence is a precise
// boundary: replayed sequences are lastSeq+1..headSequence, the live tail starts at
// headSequence+1.
import type { FastifyInstance } from "fastify";
import type { EventStore } from "@agentdeck/event-store";
import { z } from "zod";
import type { Lifecycle } from "../lifecycle.js";

const HEARTBEAT_MS = 15_000;
const WS_OPEN = 1;

const HelloMessageSchema = z.object({
  type: z.literal("hello"),
  sessionId: z.string().min(1),
  lastSeq: z.number().int().nonnegative().optional(),
});

function parseLastSeq(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function registerEventsRoute(app: FastifyInstance, store: EventStore, lifecycle: Lifecycle): void {
  app.get("/api/events", { websocket: true }, (socket, req) => {
    let unsubscribe: (() => void) | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    function send(message: unknown): void {
      if (socket.readyState === WS_OPEN) socket.send(JSON.stringify(message));
    }

    function attach(sessionId: string, lastSeq: number): void {
      const session = store.getSession(sessionId);
      if (!session) {
        send({ type: "error", message: `unknown session: ${sessionId}` });
        return;
      }
      unsubscribe?.();

      // Everything through here is synchronous (better-sqlite3) — no `await` in this function
      // body — so no live event can be appended between computing headSequence and the
      // hub.subscribe call below.
      const headSequence = store.getHeadSequence(sessionId);
      send({ type: "hello_ok", sessionId, headSequence });
      for (const event of store.getEventsSince(sessionId, lastSeq)) {
        send({ type: "event", event });
      }
      send({ type: "replay_complete", headSequence });

      unsubscribe = lifecycle.hub.subscribe(sessionId, (event) => send({ type: "event", event }));
    }

    const query = req.query as Record<string, string | undefined>;
    if (query.sessionId) attach(query.sessionId, parseLastSeq(query.lastSeq));

    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        send({ type: "error", message: "invalid JSON" });
        return;
      }
      const hello = HelloMessageSchema.safeParse(parsed);
      if (hello.success) {
        attach(hello.data.sessionId, hello.data.lastSeq ?? 0);
      }
      // "ping" and anything unrecognized: ignored — the app-level heartbeat is server -> client
      // only, per docs/api-contract.md.
    });

    heartbeatTimer = setInterval(() => send({ type: "heartbeat", ts: Date.now() }), HEARTBEAT_MS);

    socket.on("close", () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      unsubscribe?.();
    });
  });
}

import { createServer, type Server as HttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { EventStore } from "./store.js";
import { fakePayload, pickEventType } from "./events.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_HEARTBEAT_MS = 15000;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024; // guard against a runaway client message
const DEFAULT_SESSION_ID = "fake-session-1";
const WS_PATH = "/ws";

export interface ServerOptions {
  readonly port?: number; // 0 = OS-assigned ephemeral port
  readonly host?: string;
  readonly intervalMs?: number;
  readonly heartbeatMs?: number;
  readonly maxPayloadBytes?: number;
  readonly sessionId?: string;
}

export interface RunningServer {
  readonly store: EventStore;
  readonly port: number;
  readonly wsUrl: string;
  stop(): Promise<void>;
}

interface ClientHello {
  readonly type: "hello";
  readonly lastSeq?: number;
}

function isClientHello(value: unknown): value is ClientHello {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v["type"] === "hello" && (v["lastSeq"] === undefined || typeof v["lastSeq"] === "number");
}

/** ?lastSeq=<n> on the initial upgrade request, if present and valid. */
function parseLastSeqFromQuery(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const parsed = new URL(url, "http://localhost");
  const raw = parsed.searchParams.get("lastSeq");
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function send(ws: WebSocket, message: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function pagePath(): string {
  return fileURLToPath(new URL("../public/index.html", import.meta.url));
}

export function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? 0;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const sessionId = options.sessionId ?? DEFAULT_SESSION_ID;

  const store = new EventStore(sessionId);
  let tick = 0;

  const httpServer: HttpServer = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      try {
        const html = readFileSync(pagePath());
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
      } catch {
        res.writeHead(500).end("page not found");
      }
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: httpServer, path: WS_PATH, maxPayload: maxPayloadBytes });

  function replayAndAttach(ws: WebSocket, lastSeq: number): void {
    for (const event of store.since(lastSeq)) {
      send(ws, { type: "event", event });
    }
    send(ws, { type: "replayComplete", headSequence: store.headSequence });
  }

  wss.on("connection", (ws, req) => {
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });

    const queryLastSeq = parseLastSeqFromQuery(req.url);
    if (queryLastSeq !== undefined) {
      replayAndAttach(ws, queryLastSeq);
    }

    ws.on("message", (raw: RawData, isBinary: boolean) => {
      if (isBinary) return; // this spike's control channel is JSON text only
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        send(ws, { type: "error", message: "invalid JSON" });
        return;
      }
      if (isClientHello(parsed)) {
        replayAndAttach(ws, parsed.lastSeq ?? 0);
      }
    });

    // Two layers: a protocol-level ping (liveness, auto-answered by any compliant client,
    // including the browser WebSocket API) and an app-level "heartbeat" message the page
    // (and the test) can observe directly, since JS never sees raw ping/pong frames.
    const heartbeatTimer = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
      send(ws, { type: "heartbeat", timestamp: Date.now() });
    }, heartbeatMs);

    ws.on("close", () => {
      clearInterval(heartbeatTimer);
    });
  });

  const tickTimer = setInterval(() => {
    const type = pickEventType(tick);
    const event = store.append(type, fakePayload(type, tick));
    tick += 1;
    for (const client of wss.clients) {
      send(client, { type: "event", event });
    }
  }, intervalMs);

  return new Promise<RunningServer>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      const address = httpServer.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        store,
        port: boundPort,
        wsUrl: `ws://${host}:${boundPort}${WS_PATH}`,
        stop: () =>
          new Promise<void>((res) => {
            clearInterval(tickTimer);
            for (const client of wss.clients) client.terminate();
            wss.close(() => {
              httpServer.close(() => res());
            });
          }),
      });
    });
  });
}

// Connects to /api/events, sends `hello`, and drives `eventsReducer` from server messages.
// Auto-reconnects with backoff, always resuming from the highest sequence this client has
// actually applied (state.lastSeq) — so a drop mid-stream neither loses nor duplicates events.
import {
  eventsReducer,
  initialEventsState,
  nextBackoffMs,
  type EventsState,
} from "./reducer";
import { parseServerMessage } from "./protocol";

type Listener = (state: EventsState) => void;

/** Minimal surface used from `WebSocket`, so tests can inject a fake implementation. */
export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

function defaultWsFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

function eventsWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/events`;
}

export class AgentEventsClient {
  private state: EventsState = initialEventsState();
  private socket: WebSocketLike | null = null;
  private listeners = new Set<Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly wsFactory: WebSocketFactory = defaultWsFactory) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState(): EventsState {
    return this.state;
  }

  /** Connect (or switch) to a session, resuming from `lastSeq` (0 = from the start). */
  start(sessionId: string, lastSeq = 0): void {
    this.stopped = false;
    this.clearReconnectTimer();
    this.state = eventsReducer(this.state, { type: "start_session", sessionId, lastSeq });
    this.emit();
    this.openSocket();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.socket?.close();
    this.socket = null;
  }

  private openSocket(): void {
    if (this.stopped || !this.state.sessionId) return;
    this.state = eventsReducer(this.state, { type: "socket_connecting" });
    this.emit();

    const socket = this.wsFactory(eventsWsUrl());
    this.socket = socket;

    socket.onopen = () => {
      this.state = eventsReducer(this.state, { type: "socket_open" });
      socket.send(
        JSON.stringify({ type: "hello", sessionId: this.state.sessionId, lastSeq: this.state.lastSeq }),
      );
      this.emit();
    };

    socket.onmessage = (ev) => {
      const message = parseServerMessage(ev.data);
      if (!message) return;
      this.state = eventsReducer(this.state, { type: "server_message", message });
      this.emit();
    };

    socket.onclose = () => {
      this.socket = null;
      this.state = eventsReducer(this.state, { type: "socket_closed" });
      this.emit();
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // The browser follows onerror with onclose; reconnect is scheduled there.
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const attempt = this.state.reconnectAttempt + 1;
    const delay = nextBackoffMs(attempt - 1);
    this.state = eventsReducer(this.state, { type: "reconnect_scheduled", attempt });
    this.emit();
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}

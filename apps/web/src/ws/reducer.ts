// Pure reducer for the events WebSocket connection state. Kept free of WebSocket/timers so the
// reconnect-replay contract (dedupe, ordering, lastSeq tracking) is unit-testable without a
// socket. The connecting class (eventsClient.ts) is the only thing that touches `WebSocket`.
import type { AgentEvent } from "@agentdeck/shared";
import type { ServerMessage } from "./protocol";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "replaying"
  | "live"
  | "reconnecting"
  | "closed"
  | "error";

export interface EventsState {
  status: ConnectionStatus;
  sessionId: string | null;
  /** Highest event sequence applied so far. Reconnects resume from lastSeq. */
  lastSeq: number;
  events: AgentEvent[];
  lastHeartbeatTs: number | null;
  errorMessage: string | null;
  reconnectAttempt: number;
}

export function initialEventsState(): EventsState {
  return {
    status: "idle",
    sessionId: null,
    lastSeq: 0,
    events: [],
    lastHeartbeatTs: null,
    errorMessage: null,
    reconnectAttempt: 0,
  };
}

export type EventsAction =
  | { type: "start_session"; sessionId: string; lastSeq: number }
  | { type: "socket_connecting" }
  | { type: "socket_open" }
  | { type: "socket_closed" }
  | { type: "reconnect_scheduled"; attempt: number }
  | { type: "server_message"; message: ServerMessage };

/** Exponential backoff with a cap, matching spikes/mobile-streaming: 1s, 2s, 4s, ... capped 15s. */
export function nextBackoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000);
}

export function eventsReducer(state: EventsState, action: EventsAction): EventsState {
  switch (action.type) {
    case "start_session":
      return {
        ...initialEventsState(),
        sessionId: action.sessionId,
        lastSeq: action.lastSeq,
        status: "connecting",
      };
    case "socket_connecting":
      return { ...state, status: state.reconnectAttempt > 0 ? "reconnecting" : "connecting" };
    case "socket_open":
      return state; // wait for hello_ok / replay before flipping status
    case "socket_closed":
      return { ...state, status: "closed" };
    case "reconnect_scheduled":
      return { ...state, status: "reconnecting", reconnectAttempt: action.attempt };
    case "server_message":
      return applyServerMessage(state, action.message);
    default:
      return state;
  }
}

export function applyServerMessage(state: EventsState, message: ServerMessage): EventsState {
  switch (message.type) {
    case "hello_ok":
      return { ...state, sessionId: message.sessionId, status: "replaying", reconnectAttempt: 0 };
    case "event": {
      const seq = message.event.sequence;
      // De-dupe / order guard: only accept strictly-increasing sequences relative to what this
      // client has already applied. Replays and the live tail both flow through here, so a
      // server-side duplicate (or a stale reconnect race) can never double-apply.
      if (seq <= state.lastSeq) return state;
      return { ...state, events: [...state.events, message.event], lastSeq: seq };
    }
    case "replay_complete":
      return { ...state, status: "live" };
    case "heartbeat":
      return { ...state, lastHeartbeatTs: message.ts };
    case "error":
      return { ...state, status: "error", errorMessage: message.message };
    default:
      return state;
  }
}

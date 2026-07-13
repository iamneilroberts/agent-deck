// Local UI/session-scoped state that isn't server data: which session is open, filters, and
// auth gate. Server data (sessions/projects) lives in TanStack Query; live event data lives in
// the AgentEventsClient (see src/ws/useEventsClient.ts) — this store just wires the UI to them.
import { create } from "zustand";
import type { AgentKind, SessionStatus } from "@agentdeck/shared";

interface SessionFilter {
  status?: SessionStatus;
  agentKind?: AgentKind;
}

interface UiState {
  authenticated: boolean;
  setAuthenticated: (authenticated: boolean) => void;

  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;

  sessionFilter: SessionFilter;
  setSessionFilter: (filter: SessionFilter) => void;
}

export const useUiStore = create<UiState>((set) => ({
  authenticated: false,
  setAuthenticated: (authenticated) => set({ authenticated }),

  activeSessionId: null,
  setActiveSessionId: (id) => set({ activeSessionId: id }),

  sessionFilter: {},
  setSessionFilter: (sessionFilter) => set({ sessionFilter }),
}));

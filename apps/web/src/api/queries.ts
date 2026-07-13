// TanStack Query hooks — server state only (sessions/projects list + mutations). Live event
// data is NOT server state; it flows through the WebSocket store (see src/store/uiStore.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentKind, SessionStatus } from "@agentdeck/shared";
import { api } from "./client";

export const queryKeys = {
  sessions: (filters?: { projectId?: string; status?: SessionStatus }) =>
    ["sessions", filters ?? {}] as const,
  session: (id: string) => ["session", id] as const,
  sessionFiles: (id: string) => ["session", id, "files"] as const,
  sessionDiff: (id: string, path?: string) => ["session", id, "diff", path ?? null] as const,
  projects: ["projects"] as const,
};

export function useProjects() {
  return useQuery({ queryKey: queryKeys.projects, queryFn: api.listProjects });
}

export function useSessions(filters?: { projectId?: string; status?: SessionStatus }) {
  return useQuery({
    queryKey: queryKeys.sessions(filters),
    queryFn: () => api.listSessions(filters),
    refetchInterval: 15_000,
  });
}

export function useSession(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.session(id ?? ""),
    queryFn: () => api.getSession(id as string),
    enabled: Boolean(id),
  });
}

export function useSessionFiles(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.sessionFiles(id ?? ""),
    queryFn: () => api.getFiles(id as string),
    enabled: Boolean(id),
  });
}

export function useSessionDiff(id: string | undefined, path: string | undefined) {
  return useQuery({
    queryKey: queryKeys.sessionDiff(id ?? "", path),
    queryFn: () => api.getDiff(id as string, path),
    enabled: Boolean(id),
  });
}

export function useCreateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      projectId: string;
      agentKind: AgentKind;
      workingDirectory: string;
      prompt?: string;
      model?: string;
    }) => api.createSession(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
}

export function useSendMessage(sessionId: string) {
  return useMutation({
    mutationFn: (text: string) => api.sendMessage(sessionId, text, crypto.randomUUID()),
  });
}

export function useInterruptSession(sessionId: string) {
  return useMutation({
    mutationFn: () => api.interruptSession(sessionId, crypto.randomUUID()),
  });
}

export function useStopSession(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.stopSession(sessionId, crypto.randomUUID()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
}

export function useResumeSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api.resumeSession(sessionId, crypto.randomUUID()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
}

export function useResolveApproval() {
  return useMutation({
    mutationFn: (input: {
      requestId: string;
      sessionId: string;
      optionId: string;
      note?: string;
      updatedInput?: unknown;
    }) =>
      api.resolveApproval(
        input.requestId,
        {
          sessionId: input.sessionId,
          optionId: input.optionId,
          note: input.note,
          updatedInput: input.updatedInput,
        },
        crypto.randomUUID(),
      ),
  });
}

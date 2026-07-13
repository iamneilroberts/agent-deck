// Thin fetch wrapper. Always sends the auth cookie (`credentials: "include"`) since the
// server's Phase 1 auth is a session cookie, never a bearer token in the URL. Same-origin in
// production; proxied to VITE_SERVER_ORIGIN by Vite in dev (see vite.config.ts).
import type {
  AgentEvent,
  AgentKind,
  AgentSession,
  Project,
  SessionStatus,
} from "@agentdeck/shared";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body || res.statusText);
  }
  if (res.status === 202 || res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

function idempotencyHeader(key?: string): Record<string, string> {
  return key ? { "Idempotency-Key": key } : {};
}

export const api = {
  login: (password: string) =>
    request<void>("/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),

  listProjects: () => request<Project[]>("/projects"),
  createProject: (input: { name: string; repositoryPath: string; defaultBranch?: string }) =>
    request<Project>("/projects", { method: "POST", body: JSON.stringify(input) }),

  listSessions: (filters?: { projectId?: string; status?: SessionStatus }) => {
    const params = new URLSearchParams();
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.status) params.set("status", filters.status);
    const qs = params.toString();
    return request<AgentSession[]>(`/sessions${qs ? `?${qs}` : ""}`);
  },
  createSession: (input: {
    projectId: string;
    agentKind: AgentKind;
    workingDirectory: string;
    prompt?: string;
    model?: string;
  }) => request<AgentSession>("/sessions", { method: "POST", body: JSON.stringify(input) }),
  getSession: (id: string) =>
    request<{ session: AgentSession; headSequence: number }>(`/sessions/${id}`),
  getSessionEvents: (id: string, since: number) =>
    request<AgentEvent[]>(`/sessions/${id}/events?since=${since}`),

  sendMessage: (id: string, text: string, idempotencyKey?: string) =>
    request<void>(`/sessions/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
      headers: idempotencyHeader(idempotencyKey),
    }),
  interruptSession: (id: string, idempotencyKey?: string) =>
    request<void>(`/sessions/${id}/interrupt`, {
      method: "POST",
      headers: idempotencyHeader(idempotencyKey),
    }),
  stopSession: (id: string, idempotencyKey?: string) =>
    request<void>(`/sessions/${id}/stop`, {
      method: "POST",
      headers: idempotencyHeader(idempotencyKey),
    }),
  resumeSession: (id: string, idempotencyKey?: string) =>
    request<AgentSession>(`/sessions/${id}/resume`, {
      method: "POST",
      headers: idempotencyHeader(idempotencyKey),
    }),

  resolveApproval: (
    requestId: string,
    input: { sessionId: string; optionId: string; note?: string; updatedInput?: unknown },
    idempotencyKey?: string,
  ) =>
    request<void>(`/approvals/${requestId}/resolve`, {
      method: "POST",
      body: JSON.stringify(input),
      headers: idempotencyHeader(idempotencyKey),
    }),
  respondToInputRequest: (
    requestId: string,
    input: { sessionId: string; response: string },
    idempotencyKey?: string,
  ) =>
    request<void>(`/input-requests/${requestId}/respond`, {
      method: "POST",
      body: JSON.stringify(input),
      headers: idempotencyHeader(idempotencyKey),
    }),
};

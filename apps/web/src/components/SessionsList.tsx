import { useMemo, useState } from "react";
import type { AgentKind, SessionStatus } from "@agentdeck/shared";
import { useCreateSession, useProjects, useResumeSession, useSessions } from "../api/queries";
import { useUiStore } from "../store/uiStore";
import { SessionCard } from "./SessionCard";
import { NewSessionForm } from "./NewSessionForm";

const STATUS_OPTIONS: SessionStatus[] = [
  "starting",
  "running",
  "waiting_for_user",
  "waiting_for_approval",
  "paused",
  "completed",
  "failed",
  "stopped",
];
const AGENT_OPTIONS: AgentKind[] = ["codex", "claude"];

export function SessionsList() {
  const { sessionFilter, setSessionFilter, setActiveSessionId } = useUiStore();
  const [showNewSession, setShowNewSession] = useState(false);

  const projectsQuery = useProjects();
  const sessionsQuery = useSessions(sessionFilter);
  const createSession = useCreateSession();
  const resumeSession = useResumeSession();

  const projectsById = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projectsQuery.data ?? []) map.set(project.id, project.name);
    return map;
  }, [projectsQuery.data]);

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Sessions</h1>
        <button
          type="button"
          onClick={() => setShowNewSession((v) => !v)}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black"
        >
          + New
        </button>
      </div>

      {showNewSession && (
        <NewSessionForm
          projects={projectsQuery.data ?? []}
          onCreated={(session) => {
            setShowNewSession(false);
            setActiveSessionId(session.id);
          }}
          onSubmit={(input) => createSession.mutateAsync(input)}
        />
      )}

      <div className="flex gap-2">
        <select
          value={sessionFilter.status ?? ""}
          onChange={(e) =>
            setSessionFilter({
              ...sessionFilter,
              status: (e.target.value || undefined) as SessionStatus | undefined,
            })
          }
          className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        <select
          value={sessionFilter.agentKind ?? ""}
          onChange={(e) =>
            setSessionFilter({
              ...sessionFilter,
              agentKind: (e.target.value || undefined) as AgentKind | undefined,
            })
          }
          className="flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
        >
          <option value="">All agents</option>
          {AGENT_OPTIONS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </div>

      {sessionsQuery.isLoading && <div className="text-sm text-ink-dim">Loading…</div>}
      {sessionsQuery.isError && (
        <div className="text-sm text-danger">Failed to load sessions.</div>
      )}
      {sessionsQuery.data?.length === 0 && (
        <div className="text-sm text-ink-dim">No sessions yet.</div>
      )}

      <div className="flex flex-col gap-2">
        {sessionsQuery.data?.map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            projectName={projectsById.get(session.projectId) ?? session.projectId}
            onOpen={() => setActiveSessionId(session.id)}
            onResume={() =>
              resumeSession.mutate(session.id, {
                onSuccess: () => setActiveSessionId(session.id),
              })
            }
          />
        ))}
      </div>
    </div>
  );
}

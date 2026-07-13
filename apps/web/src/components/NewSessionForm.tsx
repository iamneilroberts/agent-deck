import { useState } from "react";
import type { AgentKind, AgentSession, Project } from "@agentdeck/shared";

export function NewSessionForm({
  projects,
  onSubmit,
  onCreated,
}: {
  projects: Project[];
  onSubmit: (input: {
    projectId: string;
    agentKind: AgentKind;
    workingDirectory: string;
    prompt?: string;
  }) => Promise<AgentSession>;
  onCreated: (session: AgentSession) => void;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [agentKind, setAgentKind] = useState<AgentKind>("claude");
  const [workingDirectory, setWorkingDirectory] = useState(projects[0]?.repositoryPath ?? "");
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId || !workingDirectory) return;
    setSubmitting(true);
    setError(null);
    try {
      const session = await onSubmit({
        projectId,
        agentKind,
        workingDirectory,
        prompt: prompt.trim() || undefined,
      });
      onCreated(session);
    } catch {
      setError("Could not start session.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
    >
      <select
        value={projectId}
        onChange={(e) => {
          setProjectId(e.target.value);
          const project = projects.find((p) => p.id === e.target.value);
          if (project) setWorkingDirectory(project.repositoryPath);
        }}
        className="rounded-md border border-border bg-surface-raised px-2 py-1.5 text-sm"
        required
      >
        <option value="" disabled>
          Select a project
        </option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <div className="flex gap-2">
        {(["claude", "codex"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => setAgentKind(kind)}
            className={`flex-1 rounded-md border px-2 py-1.5 text-sm ${
              agentKind === kind
                ? "border-accent bg-accent/20 text-accent"
                : "border-border text-ink-dim"
            }`}
          >
            {kind}
          </button>
        ))}
      </div>
      <input
        value={workingDirectory}
        onChange={(e) => setWorkingDirectory(e.target.value)}
        placeholder="Working directory"
        className="rounded-md border border-border bg-surface-raised px-2 py-1.5 text-sm"
        required
      />
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Initial prompt (optional)"
        rows={2}
        className="resize-none rounded-md border border-border bg-surface-raised px-2 py-1.5 text-sm"
      />
      {error && <div className="text-xs text-danger">{error}</div>}
      <button
        type="submit"
        disabled={submitting || !projectId || !workingDirectory}
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-black disabled:opacity-50"
      >
        {submitting ? "Starting…" : "Start session"}
      </button>
    </form>
  );
}

// Phase 3 git & file review endpoints. Read-only: the changed-file list and unified diff come from
// real `git` in the session's workingDirectory (the source of truth — file_changed events carry
// only optional/partial diffs); artifacts derive from the artifact_created event stream (by
// reference, no bytes). Follows the `GET /api/sessions/:id/events` template (session lookup ->
// 404). Auth guard already covers /api/sessions/:id/* (see auth.ts).
import type { FastifyInstance } from "fastify";
import type { EventStore } from "@agentdeck/event-store";
import { GitService, resolveRepoPath } from "../git/git-service.js";

export function registerGitReviewRoutes(app: FastifyInstance, store: EventStore, git: GitService): void {
  app.get<{ Params: { id: string } }>("/api/sessions/:id/files", async (req, reply) => {
    const session = store.getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: "not_found" });
    const status = await git.status(session.workingDirectory);
    return { workingDirectory: session.workingDirectory, ...status };
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/sessions/:id/diff",
    async (req, reply) => {
      const session = store.getSession(req.params.id);
      if (!session) return reply.code(404).send({ error: "not_found" });
      let safePath: string | undefined;
      if (req.query.path !== undefined) {
        const safe = resolveRepoPath(session.workingDirectory, req.query.path);
        if (!safe) return reply.code(400).send({ error: "invalid_path" });
        safePath = safe;
      }
      const diff = await git.diff(session.workingDirectory, safePath);
      return { workingDirectory: session.workingDirectory, ...diff };
    },
  );

  app.get<{ Params: { id: string } }>("/api/sessions/:id/artifacts", async (req, reply) => {
    const session = store.getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: "not_found" });
    // No type-filtered store query yet — filter the session's stream in memory (fine at session
    // scale). Returns [] for every session until a producer emits artifact_created (design §4).
    const artifacts = store
      .getEventsSince(session.id, 0)
      .filter((e) => e.type === "artifact_created")
      .map((e) => {
        const a = e as Extract<typeof e, { type: "artifact_created" }>;
        return {
          id: a.id,
          sequence: a.sequence,
          timestamp: a.timestamp,
          artifactType: a.artifactType,
          path: a.path,
          mimeType: a.mimeType,
        };
      });
    return { artifacts };
  });
}

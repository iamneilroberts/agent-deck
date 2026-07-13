// Phase 3 (/diff, /files, /artifacts) and Phase 5 (/handoff) routes: explicitly out of scope
// for Phase 1 per docs/api-contract.md — return 501 rather than 404 so a client can tell "not
// built yet" apart from "wrong URL".
import type { FastifyInstance } from "fastify";

const NOT_IMPLEMENTED_PATHS = ["diff", "files", "artifacts", "handoff"] as const;

export function registerUnroutedSessionRoutes(app: FastifyInstance): void {
  for (const path of NOT_IMPLEMENTED_PATHS) {
    app.get(`/api/sessions/:id/${path}`, async (_req, reply) => {
      return reply.code(501).send({ error: "not_implemented", detail: `${path} is not in Phase 1` });
    });
  }
}

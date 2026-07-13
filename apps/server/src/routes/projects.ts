import type { FastifyInstance } from "fastify";
import type { EventStore } from "@agentdeck/event-store";
import { CreateProjectBodySchema } from "../validation.js";

export function registerProjectRoutes(app: FastifyInstance, store: EventStore): void {
  app.get("/api/projects", async () => store.listProjects());

  app.post("/api/projects", async (req, reply) => {
    const parsed = CreateProjectBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const project = store.createProject(parsed.data);
    return reply.code(201).send(project);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "not_found" });
    return project;
  });

  // EventStore (@agentdeck/event-store) exposes createProject/getProject/listProjects only —
  // no update method yet. 501 until that lands; see apps/server/README.md "Contract deviations".
  app.patch("/api/projects/:id", async (_req, reply) => {
    return reply.code(501).send({
      error: "not_implemented",
      detail: "EventStore has no project-update method yet",
    });
  });
}

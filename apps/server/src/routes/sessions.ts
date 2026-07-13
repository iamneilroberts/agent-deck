import type { FastifyInstance } from "fastify";
import type { EventStore } from "@agentdeck/event-store";
import { SessionStatusSchema } from "@agentdeck/shared";
import type { Lifecycle } from "../lifecycle.js";
import { CreateSessionBodySchema, MessageBodySchema } from "../validation.js";
import { IdempotencyStore, idempotencyKeyFor } from "../idempotency.js";
import { mapLifecycleError } from "../http-errors.js";
import { AdapterNotRegisteredError } from "../errors.js";

export function registerSessionRoutes(
  app: FastifyInstance,
  store: EventStore,
  lifecycle: Lifecycle,
  idempotency: IdempotencyStore,
): void {
  app.get<{ Querystring: { projectId?: string; status?: string } }>("/api/sessions", async (req) => {
    const sessions = store.listSessions(req.query.projectId);
    if (!req.query.status) return sessions;
    const status = SessionStatusSchema.safeParse(req.query.status);
    return status.success ? sessions.filter((s) => s.status === status.data) : sessions;
  });

  app.post("/api/sessions", async (req, reply) => {
    const parsed = CreateSessionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    if (!store.getProject(parsed.data.projectId)) {
      return reply.code(400).send({ error: "unknown_project", projectId: parsed.data.projectId });
    }
    try {
      const session = await lifecycle.createSession(parsed.data);
      return reply.code(201).send(session);
    } catch (err) {
      if (err instanceof AdapterNotRegisteredError) {
        return reply.code(503).send({ error: "adapter_unavailable", detail: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
    const session = store.getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: "not_found" });
    return { session, headSequence: store.getHeadSequence(session.id) };
  });

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    "/api/sessions/:id/events",
    async (req, reply) => {
      const session = store.getSession(req.params.id);
      if (!session) return reply.code(404).send({ error: "not_found" });
      const since = Number(req.query.since ?? "0");
      return store.getEventsSince(session.id, Number.isFinite(since) ? since : 0);
    },
  );

  app.post<{ Params: { id: string } }>("/api/sessions/:id/messages", async (req, reply) => {
    const idemKey = idempotencyKeyFor(req);
    const cached = idemKey ? idempotency.get(idemKey) : undefined;
    if (cached) return reply.code(cached.status).send(cached.body);

    const parsed = MessageBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    try {
      await lifecycle.sendMessage(req.params.id, parsed.data.text);
    } catch (err) {
      return mapLifecycleError(err, reply);
    }
    if (idemKey) idempotency.set(idemKey, 202, undefined);
    return reply.code(202).send();
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/interrupt", async (req, reply) => {
    const idemKey = idempotencyKeyFor(req);
    const cached = idemKey ? idempotency.get(idemKey) : undefined;
    if (cached) return reply.code(cached.status).send(cached.body);

    try {
      await lifecycle.interrupt(req.params.id);
    } catch (err) {
      return mapLifecycleError(err, reply);
    }
    if (idemKey) idempotency.set(idemKey, 202, undefined);
    return reply.code(202).send();
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/stop", async (req, reply) => {
    const idemKey = idempotencyKeyFor(req);
    const cached = idemKey ? idempotency.get(idemKey) : undefined;
    if (cached) return reply.code(cached.status).send(cached.body);

    try {
      await lifecycle.stop(req.params.id);
    } catch (err) {
      return mapLifecycleError(err, reply);
    }
    if (idemKey) idempotency.set(idemKey, 202, undefined);
    return reply.code(202).send();
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/resume", async (req, reply) => {
    const idemKey = idempotencyKeyFor(req);
    const cached = idemKey ? idempotency.get(idemKey) : undefined;
    if (cached) return reply.code(cached.status).send(cached.body);

    let session;
    try {
      session = await lifecycle.resume(req.params.id);
    } catch (err) {
      return mapLifecycleError(err, reply);
    }
    if (idemKey) idempotency.set(idemKey, 200, session);
    return reply.code(200).send(session);
  });
}

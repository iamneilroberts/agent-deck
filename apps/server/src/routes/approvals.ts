import type { FastifyInstance } from "fastify";
import type { Lifecycle } from "../lifecycle.js";
import { ResolveApprovalBodySchema, RespondInputRequestBodySchema } from "../validation.js";
import { IdempotencyStore, idempotencyKeyFor } from "../idempotency.js";
import { mapLifecycleError } from "../http-errors.js";

export function registerApprovalRoutes(
  app: FastifyInstance,
  lifecycle: Lifecycle,
  idempotency: IdempotencyStore,
): void {
  app.post<{ Params: { requestId: string } }>("/api/approvals/:requestId/resolve", async (req, reply) => {
    const idemKey = idempotencyKeyFor(req);
    const cached = idemKey ? idempotency.get(idemKey) : undefined;
    if (cached) return reply.code(cached.status).send(cached.body);

    const parsed = ResolveApprovalBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    try {
      await lifecycle.resolveApproval(
        parsed.data.sessionId,
        req.params.requestId,
        parsed.data.optionId,
        parsed.data.note,
        parsed.data.updatedInput,
      );
    } catch (err) {
      return mapLifecycleError(err, reply);
    }
    if (idemKey) idempotency.set(idemKey, 202, undefined);
    return reply.code(202).send();
  });

  app.post<{ Params: { requestId: string } }>("/api/input-requests/:requestId/respond", async (req, reply) => {
    const idemKey = idempotencyKeyFor(req);
    const cached = idemKey ? idempotency.get(idemKey) : undefined;
    if (cached) return reply.code(cached.status).send(cached.body);

    const parsed = RespondInputRequestBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    try {
      await lifecycle.respondToInputRequest(parsed.data.sessionId, req.params.requestId, parsed.data.response);
    } catch (err) {
      return mapLifecycleError(err, reply);
    }
    if (idemKey) idempotency.set(idemKey, 202, undefined);
    return reply.code(202).send();
  });
}

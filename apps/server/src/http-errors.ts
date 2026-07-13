// Maps lifecycle-layer errors to HTTP responses. Shared across the session/approval routes so
// "unknown session" etc. produce one consistent response shape everywhere.
import type { FastifyReply } from "fastify";
import {
  AdapterNotRegisteredError,
  InvalidApprovalError,
  InvalidUserInputResponseError,
  SessionNotResumableError,
  UnknownSessionError,
} from "./errors.js";

export function mapLifecycleError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof UnknownSessionError) {
    return reply.code(404).send({ error: "not_found", detail: err.message });
  }
  if (err instanceof InvalidApprovalError || err instanceof InvalidUserInputResponseError) {
    return reply.code(400).send({ error: "invalid_request", detail: err.message });
  }
  if (err instanceof SessionNotResumableError) {
    return reply.code(409).send({ error: "not_resumable", detail: err.message });
  }
  if (err instanceof AdapterNotRegisteredError) {
    return reply.code(503).send({ error: "adapter_unavailable", detail: err.message });
  }
  throw err;
}

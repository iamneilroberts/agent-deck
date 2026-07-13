// `buildServer(deps)` is the Fastify factory: everything the server needs (the event store, the
// adapter registry, the Phase 1 password) is injected, never reached for globally, so tests can
// build a fully wired server against an in-memory store and a deterministic FakeAdapter.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import type { ServerDeps } from "./types.js";
import { AuthState, registerAuthGuard, registerAuthRoutes } from "./auth.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerCapabilitiesRoute } from "./routes/capabilities.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerUnroutedSessionRoutes } from "./routes/unrouted.js";
import { registerEventsRoute } from "./ws/events-route.js";
import { Lifecycle } from "./lifecycle.js";
import { IdempotencyStore } from "./idempotency.js";

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      // Never let the session cookie or a bearer token reach a log line.
      redact: ["req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']"],
    },
  });

  await app.register(cookie);
  await app.register(websocket);

  const auth = new AuthState();
  registerAuthGuard(app, auth);
  registerAuthRoutes(app, auth, deps.password);

  registerHealthRoute(app, deps.adapters, deps.version ?? "0.0.0");
  registerCapabilitiesRoute(app, deps.adapters);
  registerProjectRoutes(app, deps.store);

  const lifecycle = new Lifecycle(deps.store, deps.adapters, app.log);
  const idempotency = new IdempotencyStore();
  registerSessionRoutes(app, deps.store, lifecycle, idempotency);
  registerApprovalRoutes(app, lifecycle, idempotency);
  registerUnroutedSessionRoutes(app);
  registerEventsRoute(app, deps.store, lifecycle);

  return app;
}

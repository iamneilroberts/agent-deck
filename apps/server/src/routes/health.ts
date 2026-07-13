import type { FastifyInstance } from "fastify";
import type { AdapterRegistry } from "../types.js";

/** Fast liveness probe — reports which adapter kinds are registered without awaiting each
 *  adapter's (potentially slow) `detectInstallation()`. That detail lives in /api/capabilities. */
export function registerHealthRoute(app: FastifyInstance, adapters: AdapterRegistry, version: string): void {
  app.get("/api/health", async () => {
    const registered: Record<string, boolean> = {};
    for (const kind of adapters.keys()) registered[kind] = true;
    return { ok: true, version, node: process.version, adapters: registered };
  });
}

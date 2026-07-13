import type { FastifyInstance } from "fastify";
import type { InstallationStatus } from "@agentdeck/shared";
import type { AdapterRegistry } from "../types.js";

export function registerCapabilitiesRoute(app: FastifyInstance, adapters: AdapterRegistry): void {
  app.get("/api/capabilities", async () => {
    const result: Record<string, InstallationStatus> = {};
    await Promise.all(
      [...adapters.entries()].map(async ([kind, adapter]) => {
        result[kind] = await adapter.detectInstallation();
      }),
    );
    return result;
  });
}

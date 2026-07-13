// Process entry point. `npm run dev` (root) or `npm run dev --workspace @agentdeck/server`
// starts this. See README.md for env vars.
import { EventStore } from "@agentdeck/event-store";
import { createDefaultAdapterRegistry } from "./adapters/registry.js";
import { buildServer } from "./server.js";

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PASSWORD = "agentdeck-dev";
const DEFAULT_DB_PATH = "./agentdeck.sqlite3";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const host = process.env.HOST ?? DEFAULT_HOST;
  const password = process.env.AGENTDECK_PASSWORD ?? DEFAULT_PASSWORD;
  const dbPath = process.env.AGENTDECK_DB_PATH ?? DEFAULT_DB_PATH;

  const store = new EventStore(dbPath);
  const adapters = createDefaultAdapterRegistry();
  const app = await buildServer({ store, adapters, password });

  if (!process.env.AGENTDECK_PASSWORD) {
    app.log.warn(`AGENTDECK_PASSWORD not set — using the Phase 1 dev default. See README.md.`);
  }

  await app.listen({ port, host });
  app.log.info(`AgentDeck server listening on http://${host}:${port}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

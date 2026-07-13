import { startServer } from "./server.js";

const server = await startServer({ port: 8799, intervalMs: 750 });

console.log(`Spike C server listening on http://127.0.0.1:${server.port}`);
console.log(`Open http://127.0.0.1:${server.port}/ on your phone (over Tailscale) or desktop.`);
console.log(`WebSocket endpoint: ${server.wsUrl}`);
console.log("Ctrl+C to stop.");

process.on("SIGINT", () => {
  void server.stop().then(() => process.exit(0));
});

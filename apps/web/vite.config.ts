import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The server this dev-proxies to. Same-origin in production (server serves the built bundle);
// in dev, Vite proxies /api (REST + the /api/events WebSocket upgrade) to the real Fastify
// server so `npm run dev` works against apps/server directly.
const serverOrigin = process.env.VITE_SERVER_ORIGIN ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: serverOrigin,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    globals: false,
  },
});

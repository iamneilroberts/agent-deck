// Phase 1 single-user auth skeleton (docs/api-contract.md "Auth skeleton"): a secure,
// http-only, SameSite=strict cookie carrying an opaque server-issued token, checked against an
// in-memory session table. No JWT, no bearer-token-in-URL, no password ever leaves this file.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { LoginBodySchema } from "./validation.js";

export const SESSION_COOKIE_NAME = "agentdeck_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days - a personal single-user app, not a bank

export class AuthState {
  private readonly tokens = new Map<string, number>(); // token -> expiresAt (ms epoch)

  private prune(): void {
    const now = Date.now();
    for (const [token, expiresAt] of this.tokens) {
      if (expiresAt <= now) this.tokens.delete(token);
    }
  }

  isValid(token: string | undefined): boolean {
    if (!token) return false;
    this.prune();
    const expiresAt = this.tokens.get(token);
    return expiresAt !== undefined && expiresAt > Date.now();
  }

  /** Issues a fresh token and invalidates none of the caller's other sessions (multi-device). */
  issue(): string {
    this.prune();
    const token = randomBytes(32).toString("hex");
    this.tokens.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }

  revoke(token: string | undefined): void {
    if (token) this.tokens.delete(token);
  }
}

function passwordMatches(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch rather than returning false - guard first.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Paths reachable without a session cookie. Everything else under `/api/*` is gated. */
const PUBLIC_PATHS = new Set(["/api/health", "/api/auth/login"]);

export function registerAuthGuard(app: FastifyInstance, auth: AuthState): void {
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const path = req.url.split("?")[0] ?? req.url;
    if (PUBLIC_PATHS.has(path)) return;
    const token = req.cookies[SESSION_COOKIE_NAME];
    if (!auth.isValid(token)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });
}

export function registerAuthRoutes(app: FastifyInstance, auth: AuthState, password: string): void {
  app.post("/api/auth/login", async (req, reply) => {
    const parsed = LoginBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    if (!passwordMatches(parsed.data.password, password)) {
      return reply.code(401).send({ error: "invalid_password" });
    }
    const token = auth.issue();
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return reply.code(204).send();
  });

  app.post("/api/auth/logout", async (req, reply) => {
    auth.revoke(req.cookies[SESSION_COOKIE_NAME]);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return reply.code(204).send();
  });
}

// Phase 1 "accept + de-dupe best-effort" idempotency (docs/api-contract.md): an in-memory
// cache keyed by method+path+Idempotency-Key, so a double mobile submit replays the first
// response instead of re-running the mutation. Not durable across restarts — a full store is
// explicitly deferred past Phase 1.
import type { FastifyRequest } from "fastify";

interface CachedResponse {
  readonly status: number;
  readonly body: unknown;
  readonly expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;

export class IdempotencyStore {
  private readonly cache = new Map<string, CachedResponse>();

  get(key: string): CachedResponse | undefined {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return hit;
  }

  set(key: string, status: number, body: unknown): void {
    this.cache.set(key, { status, body, expiresAt: Date.now() + TTL_MS });
  }
}

/** `undefined` when the request has no `Idempotency-Key` header — callers skip de-dupe then. */
export function idempotencyKeyFor(req: FastifyRequest): string | undefined {
  const header = req.headers["idempotency-key"];
  const raw = Array.isArray(header) ? header[0] : header;
  return raw ? `${req.method}:${req.url}:${raw}` : undefined;
}

import type { Request, Response } from 'express';
import { getClientIp } from './proxy.js';

type Bucket = {
  tokens: number;
  updatedAt: number;
};

type Decision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; limit: number; cost: number; kind: 'requests' | 'items' };

const buckets = new Map<string, Bucket>();
let lastSweepAt = 0;

function parsePositiveInt(raw: unknown, fallback: number) {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseNonNegativeInt(raw: unknown, fallback: number) {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function parseBurstMultiplier(raw: unknown) {
  const n = raw === undefined ? 2 : Number(raw);
  if (!Number.isFinite(n) || n < 1) return 2;
  return Math.min(20, n);
}

function getActorKey(req: Request) {
  if (req.auth?.apiKey) return `api-key:${req.auth.apiKey.id}`;
  if (req.auth?.user) return `user:${req.auth.user.id}`;
  return `ip:${getClientIp(req)}`;
}

function consume(kind: 'requests' | 'items', actor: string, cost: number, limitPerMinute: number, now: number): Decision {
  if (limitPerMinute <= 0 || cost <= 0) return { allowed: true };

  const burst = parseBurstMultiplier(process.env.RAPHAEL_INGEST_RATE_LIMIT_BURST_MULTIPLIER);
  const capacity = Math.max(limitPerMinute, Math.ceil(limitPerMinute * burst));
  const key = `${kind}:${actor}`;
  const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: now };
  const elapsedMs = Math.max(0, now - bucket.updatedAt);
  const refill = (elapsedMs / 60_000) * limitPerMinute;
  const available = Math.min(capacity, bucket.tokens + refill);

  if (available < cost) {
    bucket.tokens = available;
    bucket.updatedAt = now;
    buckets.set(key, bucket);
    const missing = cost - available;
    const retryAfterSeconds = Math.max(1, Math.ceil((missing / limitPerMinute) * 60));
    return { allowed: false, retryAfterSeconds, limit: limitPerMinute, cost, kind };
  }

  bucket.tokens = available - cost;
  bucket.updatedAt = now;
  buckets.set(key, bucket);
  return { allowed: true };
}

function sweep(now: number) {
  if (now - lastSweepAt < 60_000) return;
  lastSweepAt = now;
  const maxAgeMs = 10 * 60_000;
  for (const [key, bucket] of buckets.entries()) {
    if (now - bucket.updatedAt > maxAgeMs) buckets.delete(key);
  }
}

export function checkIngestRateLimit(req: Request, res: Response, itemCount: number) {
  const requestLimit = parseNonNegativeInt(process.env.RAPHAEL_INGEST_RATE_LIMIT_REQUESTS_PER_MINUTE, 600);
  const itemLimit = parseNonNegativeInt(process.env.RAPHAEL_INGEST_RATE_LIMIT_ITEMS_PER_MINUTE, 60_000);
  const now = Date.now();
  sweep(now);

  const actor = getActorKey(req);
  const requestDecision = consume('requests', actor, 1, requestLimit, now);
  const itemDecision = requestDecision.allowed
    ? consume('items', actor, Math.max(0, itemCount), itemLimit, now)
    : requestDecision;

  const decision = requestDecision.allowed ? itemDecision : requestDecision;
  if (decision.allowed) return true;

  res.setHeader('Retry-After', String(decision.retryAfterSeconds));
  res.status(429).json({
    error: `Ingest ${decision.kind} rate limit exceeded`,
    limit_per_minute: decision.limit,
    retry_after_seconds: decision.retryAfterSeconds,
  });
  return false;
}

export function resetIngestRateLimitForTests() {
  buckets.clear();
  lastSweepAt = 0;
}

export function ingestRateLimitBucketCountForTests() {
  return buckets.size;
}

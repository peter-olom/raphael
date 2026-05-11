import type { Express, Request } from 'express';

function parseBoolean(raw: string) {
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return null;
}

export function parseTrustProxySetting(raw: string | undefined) {
  const value = (raw || 'loopback').trim();
  if (!value) return 'loopback';

  const booleanValue = parseBoolean(value);
  if (booleanValue !== null) return booleanValue;

  const hopCount = Number(value);
  if (Number.isInteger(hopCount) && hopCount >= 0) return hopCount;

  return value;
}

export function configureTrustProxy(app: Express) {
  app.set('trust proxy', parseTrustProxySetting(process.env.RAPHAEL_TRUST_PROXY));
}

export function getClientIp(req: Request) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

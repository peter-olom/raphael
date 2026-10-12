import type { Request } from 'express';
import { createHash } from 'crypto';
import { db, DEFAULT_DROP_ID } from './db/core.js';
import type { AuthContext } from './auth.js';
import { maintenanceActive } from './maintenanceGate.js';

let snapshot: { drops: Map<string, number>; keys: Map<string, AuthContext>; users: Map<string, any>; permissions: Map<string, any>; activeSessions: Map<string, any> } | null = null;
const sessions = new Map<string, { context: AuthContext; expires: number; id: string; tokenHash: string }>();
function asciiFold(value: string) { return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase()); }
function sessionIdentity(req: Request) { return createHash('sha256').update(req.headers.cookie || '').digest('hex'); }
export function rememberSession(req: Request, context: AuthContext, expires: unknown, sessionId: unknown, token: unknown) {
  if (!req.headers.cookie || !sessionId || !token) return;
  const expiry = new Date(expires as any).getTime();
  if (!Number.isFinite(expiry)) return;
  if (sessions.size >= 2000) sessions.delete(sessions.keys().next().value!);
  sessions.set(sessionIdentity(req), { context, expires: expiry, id: String(sessionId), tokenHash: createHash('sha256').update(String(token)).digest('hex') });
}
export function captureMaintenanceSnapshot() {
  const drops = new Map<string, number>();
  for (const drop of db.prepare('SELECT id, name FROM drops').all() as any[]) {
    drops.set(`id:${drop.id}`, drop.id); drops.set(`name:${asciiFold(drop.name)}`, drop.id);
  }
  drops.set('default:', DEFAULT_DROP_ID);
  const keys = new Map<string, AuthContext>();
  const permissions = db.prepare('SELECT * FROM api_key_permissions').all() as any[];
  for (const key of db.prepare('SELECT * FROM api_keys WHERE revoked_at IS NULL').all() as any[]) {
    keys.set(key.key_hash, { isAuthenticated: true, authType: 'api_key', apiKey: key,
      apiKeyPermissions: permissions.filter((permission) => permission.api_key_id === key.id), apiKeyUsageDropId: null });
  }
  const users = new Map<string, any>((db.prepare('SELECT * FROM user_profiles').all() as any[]).map((user) => [user.user_id, user]));
  const userPermissions = new Map<string, any>((db.prepare('SELECT * FROM user_drop_permissions').all() as any[]).map((permission) => [`${permission.user_id}:${permission.drop_id}`, permission]));
  const activeSessions = new Map<string, any>();
  for (const row of db.prepare('SELECT id, token, userId, expiresAt FROM session').all() as any[]) {
    const expiry = typeof row.expiresAt === 'number' ? row.expiresAt : new Date(row.expiresAt).getTime();
    if (!Number.isFinite(expiry) || expiry <= Date.now()) continue;
    activeSessions.set(row.id, { userId: row.userId, expires: expiry, tokenHash: createHash('sha256').update(row.token).digest('hex') });
  }
  snapshot = { drops, keys, users, permissions: userPermissions, activeSessions };
}
export function clearMaintenanceSnapshot() { snapshot = null; }
export function snapshotReady() { return snapshot !== null; }
export function snapshotAuth(req: Request, apiKey: string | null): AuthContext | null {
  if (!snapshot) return null;
  const session = sessions.get(sessionIdentity(req));
  if (session && session.expires > Date.now() && session.context.user) {
    const live = snapshot.activeSessions.get(session.id);
    const current = live?.userId === session.context.user.id && live?.tokenHash === session.tokenHash && live.expires > Date.now() ? snapshot.users.get(session.context.user.id) : null;
    if (current) return { ...session.context, isAuthenticated: !current.disabled,
      authType: current.disabled ? 'disabled' : 'session', user: { ...session.context.user, role: current.role, disabled: Boolean(current.disabled) } };
  }
  if (apiKey) {
    const key = snapshot.keys.get(createHash('sha256').update(apiKey).digest('hex'));
    return key ? { ...key } : { isAuthenticated: false, authType: 'none' };
  }
  // Never touch BetterAuth during maintenance to resolve uncached cookies.
  if (req.headers.cookie) return null;
  return { isAuthenticated: false, authType: 'none' };
}
export function snapshotPermission(userId: string, dropId: number) { return snapshot?.permissions.get(`${userId}:${dropId}`); }
export function snapshotDrop(raw: string) {
  if (!maintenanceActive()) throw new Error('Snapshot drop lookup outside maintenance');
  const value = raw.trim();
  const key = !value ? 'default:' : /^\d+$/.test(value) ? `id:${Number(value)}` : `name:${asciiFold(value)}`;
  return snapshot?.drops.get(key) ?? null;
}

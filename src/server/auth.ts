import Database from 'better-sqlite3';
import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import { genericOAuth } from 'better-auth/plugins';
import {
  DB_PATH,
  countUserProfiles,
  getUserDropPermission,
  getUserProfile,
  listUserDropPermissions,
  logApiKeyUsage,
  upsertUserProfile,
  getApiKeyByHash,
  getApiKeyPermissions,
} from './db/sqlite.js';

export interface AuthUser {
  id: string;
  email: string;
  role: 'admin' | 'member';
  disabled: boolean;
}

export interface AuthApiKey {
  id: number;
  service_account_id: number;
  name: string | null;
  key_prefix: string;
  created_by_user_id: string;
  created_at: number;
  revoked_at: number | null;
}

export interface AuthContext {
  isAuthenticated: boolean;
  authType: 'none' | 'session' | 'api_key' | 'disabled';
  user?: AuthUser;
  apiKey?: AuthApiKey;
  apiKeyPermissions?: Array<{ drop_id: number; can_ingest: number; can_query: number }>;
  apiKeyUsageDropId?: number | null;
}

function isTruthy(value: unknown) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

export function authEnabled() {
  return isTruthy(process.env.RAPHAEL_AUTH_ENABLED);
}

const emailPasswordEnabled = isTruthy(process.env.RAPHAEL_AUTH_EMAIL_PASSWORD_ENABLED);

const authDb = new Database(DB_PATH);
authDb.pragma('journal_mode = WAL');

type GenericOAuthConfig = {
  providerId: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  scopes?: string[];
  authorizationParams?: Record<string, string>;
  redirectUri?: string;
};

const socialProviders: Record<string, any> = {};

if (process.env.RAPHAEL_AUTH_GOOGLE_CLIENT_ID && process.env.RAPHAEL_AUTH_GOOGLE_CLIENT_SECRET) {
  socialProviders.google = {
    clientId: process.env.RAPHAEL_AUTH_GOOGLE_CLIENT_ID,
    clientSecret: process.env.RAPHAEL_AUTH_GOOGLE_CLIENT_SECRET,
  };
}

if (process.env.RAPHAEL_AUTH_GITHUB_CLIENT_ID && process.env.RAPHAEL_AUTH_GITHUB_CLIENT_SECRET) {
  socialProviders.github = {
    clientId: process.env.RAPHAEL_AUTH_GITHUB_CLIENT_ID,
    clientSecret: process.env.RAPHAEL_AUTH_GITHUB_CLIENT_SECRET,
  };
}

const genericProviders: GenericOAuthConfig[] = [];

const azureTenantId = process.env.RAPHAEL_AUTH_AZURE_TENANT_ID;
const azureClientId = process.env.RAPHAEL_AUTH_AZURE_CLIENT_ID;
const azureClientSecret = process.env.RAPHAEL_AUTH_AZURE_CLIENT_SECRET;
if (azureTenantId && azureClientId && azureClientSecret) {
  genericProviders.push({
    providerId: 'microsoft',
    clientId: azureClientId,
    clientSecret: azureClientSecret,
    discoveryUrl: `https://login.microsoftonline.com/${azureTenantId}/v2.0/.well-known/openid-configuration`,
    scopes: ['openid', 'profile', 'email'],
  });
}

const genericRaw = process.env.RAPHAEL_AUTH_GENERIC_OAUTH;
if (genericRaw) {
  try {
    const parsed = JSON.parse(genericRaw);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry && entry.providerId && entry.clientId && entry.clientSecret) {
          genericProviders.push(entry as GenericOAuthConfig);
        }
      }
    }
  } catch (error) {
    console.warn('Failed to parse RAPHAEL_AUTH_GENERIC_OAUTH:', error);
  }
}

const plugins = genericProviders.length > 0 ? [genericOAuth({ config: genericProviders })] : [];

const trustedOriginsRaw = process.env.RAPHAEL_AUTH_TRUSTED_ORIGINS;
const trustedOrigins = trustedOriginsRaw
  ? trustedOriginsRaw.split(',').map((origin) => origin.trim()).filter(Boolean)
  : undefined;

const sessionTtlRaw = process.env.RAPHAEL_AUTH_SESSION_TTL_HOURS;
const sessionTtlHours = sessionTtlRaw ? Number(sessionTtlRaw) : undefined;
const sessionExpiresIn =
  sessionTtlHours && Number.isFinite(sessionTtlHours) && sessionTtlHours > 0
    ? Math.round(sessionTtlHours * 60 * 60)
    : undefined;

const baseURL = process.env.BETTER_AUTH_BASE_URL || process.env.BETTER_AUTH_URL;

export const auth: ReturnType<typeof betterAuth> = betterAuth({
  appName: 'Raphael',
  database: authDb,
  ...(baseURL ? { baseURL } : {}),
  trustedOrigins,
  emailAndPassword: {
    enabled: emailPasswordEnabled,
  },
  socialProviders,
  account: {
    accountLinking: {
      enabled: true,
      allowDifferentEmails: false,
    },
  },
  plugins,
  ...(sessionExpiresIn ? { session: { expiresIn: sessionExpiresIn } } : {}),
});

const providerList = [...Object.keys(socialProviders), ...genericProviders.map((p) => p.providerId)];

function providerLabel(providerId: string) {
  const normalized = providerId.toLowerCase();
  if (normalized === 'github') return 'GitHub';
  if (normalized === 'google') return 'Google';
  if (normalized === 'microsoft' || normalized === 'azure') return 'Microsoft';
  return providerId;
}

export function getAuthConfigSummary() {
  return {
    enabled: authEnabled(),
    email_password_enabled: emailPasswordEnabled,
    providers: providerList.map((id) => ({ id, label: providerLabel(id) })),
  };
}

function extractApiKey(req: Request) {
  const header = req.header('authorization');
  if (header && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return (
    req.header('x-api-key') ||
    req.header('x-raphael-api-key') ||
    req.header('x-raphael-key') ||
    req.header('x-raphael-token')
  );
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function ensureUserProfile(user: { id: string; email: string }) {
  const email = user.email.toLowerCase();
  const existing = getUserProfile(user.id);
  const adminEmail = (process.env.RAPHAEL_ADMIN_EMAIL || '').trim().toLowerCase();
  const isAdminEmail = Boolean(adminEmail && adminEmail === email);

  let role: 'admin' | 'member' | undefined = undefined;
  if (!existing) {
    const hasUsers = countUserProfiles() > 0;
    role = isAdminEmail ? 'admin' : hasUsers ? 'member' : 'admin';
  } else if (isAdminEmail && existing.role !== 'admin') {
    role = 'admin';
  }

  const updated = upsertUserProfile({
    user_id: user.id,
    email,
    role,
    last_login_at: Date.now(),
  });

  return updated;
}

export async function ensureAdminSeed() {
  if (!authEnabled()) return;
  if (!emailPasswordEnabled) return;
  const adminEmail = (process.env.RAPHAEL_ADMIN_EMAIL || '').trim();
  const adminPassword = (process.env.RAPHAEL_ADMIN_PASSWORD || '').trim();
  if (!adminEmail || !adminPassword) return;

  const normalized = adminEmail.toLowerCase();
  const row = authDb.prepare(`SELECT id FROM user WHERE email = ?`).get(normalized) as { id: string } | undefined;
  if (!row) {
    try {
      await auth.api.signUpEmail({
        body: {
          email: normalized,
          password: adminPassword,
          name: 'Admin',
        },
      });
    } catch (error) {
      console.warn('Failed to seed admin user:', error);
      return;
    }
  }

  try {
    const ctx = auth.$context as any;
    if (!ctx?.password || !ctx?.internalAdapter?.updatePassword) return;
    const userId = row?.id ?? (authDb.prepare(`SELECT id FROM user WHERE email = ?`).get(normalized) as { id: string } | undefined)?.id;
    if (!userId) return;
    const hashed = await ctx.password.hash(adminPassword);
    await ctx.internalAdapter.updatePassword(userId, hashed);
  } catch (error) {
    console.warn('Failed to update admin password:', error);
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!authEnabled()) {
    req.auth = { isAuthenticated: false, authType: 'none' };
    return next();
  }

  if (req.path.startsWith('/api/auth')) {
    req.auth = { isAuthenticated: false, authType: 'none' };
    return next();
  }

  try {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (session?.user) {
      const profile = await ensureUserProfile({ id: session.user.id, email: session.user.email });
      if (profile?.disabled) {
        req.auth = {
          isAuthenticated: false,
          authType: 'disabled',
          user: {
            id: session.user.id,
            email: session.user.email,
            role: profile.role,
            disabled: true,
          },
        };
        return next();
      }

      req.auth = {
        isAuthenticated: true,
        authType: 'session',
        user: {
          id: session.user.id,
          email: session.user.email,
          role: profile?.role ?? 'member',
          disabled: false,
        },
      };
      return next();
    }
  } catch (error) {
    console.warn('Failed to resolve session:', error);
  }

  const apiKey = extractApiKey(req);
  if (apiKey) {
    const keyHash = hashToken(apiKey);
    const key = getApiKeyByHash(keyHash);
    if (key && !key.revoked_at) {
      req.auth = {
        isAuthenticated: true,
        authType: 'api_key',
        apiKey: key,
        apiKeyPermissions: getApiKeyPermissions(key.id),
        apiKeyUsageDropId: null,
      };

      res.on('finish', () => {
        const ctx = req.auth;
        if (!ctx?.apiKey) return;
        logApiKeyUsage({
          api_key_id: ctx.apiKey.id,
          drop_id: ctx.apiKeyUsageDropId ?? null,
          method: req.method,
          path: req.originalUrl || req.url,
          status_code: res.statusCode,
          ip_address: req.ip,
          user_agent: req.header('user-agent') || null,
        });
      });

      return next();
    }
  }

  req.auth = { isAuthenticated: false, authType: 'none' };
  return next();
}

export function requireAuth(req: Request, res: Response) {
  if (!authEnabled()) return true;
  if (req.auth?.authType === 'disabled') {
    res.status(403).json({ error: 'User is disabled' });
    return false;
  }
  if (req.auth?.isAuthenticated) return true;
  res.status(401).json({ error: 'Authentication required' });
  return false;
}

export function requireAdmin(req: Request, res: Response) {
  if (!authEnabled()) return true;
  if (req.auth?.authType === 'disabled') {
    res.status(403).json({ error: 'User is disabled' });
    return false;
  }
  if (req.auth?.user?.role === 'admin') return true;
  res.status(403).json({ error: 'Admin access required' });
  return false;
}

export function requireDropAccess(req: Request, res: Response, dropId: number, action: 'ingest' | 'query') {
  if (!authEnabled()) return true;
  if (req.auth?.authType === 'disabled') {
    res.status(403).json({ error: 'User is disabled' });
    return false;
  }
  if (req.auth?.user) {
    if (req.auth.user.role === 'admin') return true;
    const permission = getUserDropPermission(req.auth.user.id, dropId);
    const allowed = action === 'ingest' ? permission?.can_ingest : permission?.can_query;
    if (allowed) return true;
    res.status(403).json({ error: `User does not have ${action} permissions for this drop` });
    return false;
  }
  if (!req.auth?.apiKey) {
    res.status(401).json({ error: 'API key required' });
    return false;
  }
  const permission = req.auth.apiKeyPermissions?.find((p) => p.drop_id === dropId);
  const allowed = action === 'ingest' ? permission?.can_ingest : permission?.can_query;
  if (!allowed) {
    res.status(403).json({ error: `API key does not have ${action} permissions for this drop` });
    return false;
  }
  return true;
}

export function noteApiKeyUsageDrop(req: Request, dropId: number | null) {
  if (req.auth?.apiKey) {
    req.auth.apiKeyUsageDropId = dropId;
  }
}

export function listUserPermissions(userId: string) {
  return listUserDropPermissions(userId);
}

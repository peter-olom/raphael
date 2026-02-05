import { Router, Request, Response } from 'express';
import {
  createApiKey,
  createServiceAccount,
  deleteServiceAccount,
  getServiceAccountById,
  getApiKeyPermissions,
  getUserProfile,
  listApiKeyUsage,
  listApiKeys,
  listServiceAccounts,
  listUserDropPermissions,
  listUserProfiles,
  resolveDropId,
  revokeApiKey,
  setApiKeyPermissions,
  setUserDropPermissions,
  updateUserDisabled,
  updateUserRole,
} from '../db/sqlite.js';
import { authEnabled, hashToken, requireAdmin, requireAuth } from '../auth.js';
import { randomBytes } from 'crypto';

export const adminRouter = Router();

adminRouter.get('/me', (req: Request, res: Response) => {
  if (!authEnabled()) {
    res.json({ enabled: false });
    return;
  }
  if (!requireAuth(req, res)) return;
  res.json({ enabled: true, user: req.auth?.user ?? null });
});

adminRouter.get('/users', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.json(listUserProfiles());
});

adminRouter.patch('/users/:id', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const userId = (req.params as any).id as string;
  const profile = getUserProfile(userId);
  if (!profile) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  const roleRaw = req.body?.role;
  const disabledRaw = req.body?.disabled;

  if (roleRaw !== undefined) {
    const role = roleRaw === 'admin' ? 'admin' : roleRaw === 'member' ? 'member' : null;
    if (!role) {
      res.status(400).json({ error: 'Invalid role' });
      return;
    }
    updateUserRole(userId, role);
  }

  if (disabledRaw !== undefined) {
    updateUserDisabled(userId, Boolean(disabledRaw));
  }

  res.json(getUserProfile(userId));
});

adminRouter.get('/users/:id/permissions', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const userId = (req.params as any).id as string;
  const profile = getUserProfile(userId);
  if (!profile) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(listUserDropPermissions(userId));
});

adminRouter.put('/users/:id/permissions', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const userId = (req.params as any).id as string;
  const profile = getUserProfile(userId);
  if (!profile) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  const normalized = permissions
    .map((p: any) => {
      const dropRaw = p?.drop_id ?? p?.drop ?? p?.drop_name;
      const dropId = resolveDropId(dropRaw?.toString?.() ?? '', false);
      if (!dropId) return null;
      return {
        drop_id: dropId,
        can_ingest: Boolean(p?.can_ingest ?? p?.ingest ?? false),
        can_query: Boolean(p?.can_query ?? p?.query ?? false),
      };
    })
    .filter(Boolean) as Array<{ drop_id: number; can_ingest: boolean; can_query: boolean }>;

  setUserDropPermissions(userId, normalized);
  res.json(listUserDropPermissions(userId));
});

adminRouter.get('/service-accounts', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  res.json(listServiceAccounts());
});

adminRouter.post('/service-accounts', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const name = (req.body?.name ?? '').toString();
    const row = createServiceAccount(name, req.auth!.user!.id);
    res.status(201).json(row);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || 'Failed to create service account' });
  }
});

adminRouter.delete('/service-accounts/:id', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const raw = (req.params as any).id as string | string[];
  const id = Number.parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid service account id' });
    return;
  }
  const ok = deleteServiceAccount(id);
  if (!ok) {
    res.status(404).json({ error: 'Service account not found' });
    return;
  }
  res.json({ success: true });
});

adminRouter.get('/api-keys', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const raw = req.query.service_account_id as string | undefined;
  const serviceAccountId = raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined;
  const keys = listApiKeys(serviceAccountId) as Array<any>;
  const withPerms = keys.map((k) => ({ ...k, permissions: getApiKeyPermissions(k.id) }));
  res.json(withPerms);
});

adminRouter.post('/api-keys', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const serviceAccountId = Number(req.body?.service_account_id);
  if (!Number.isFinite(serviceAccountId)) {
    res.status(400).json({ error: 'service_account_id is required' });
    return;
  }
  const serviceAccount = getServiceAccountById(serviceAccountId);
  if (!serviceAccount) {
    res.status(404).json({ error: 'Service account not found' });
    return;
  }

  const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  if (!permissions.length) {
    res.status(400).json({ error: 'At least one permission is required' });
    return;
  }

  const normalized = permissions
    .map((p: any) => {
      const dropRaw = p?.drop_id ?? p?.drop ?? p?.drop_name;
      const dropId = resolveDropId(dropRaw?.toString?.() ?? '', false);
      if (!dropId) return null;
      return {
        drop_id: dropId,
        can_ingest: Boolean(p?.can_ingest ?? p?.ingest ?? false),
        can_query: Boolean(p?.can_query ?? p?.query ?? false),
      };
    })
    .filter(Boolean) as Array<{ drop_id: number; can_ingest: boolean; can_query: boolean }>;

  if (!normalized.length) {
    res.status(400).json({ error: 'No valid drop permissions provided' });
    return;
  }
  if (!normalized.some((p) => p.can_ingest || p.can_query)) {
    res.status(400).json({ error: 'At least one permission must be granted' });
    return;
  }

  const rawName = req.body?.name;
  const name = rawName === undefined ? null : (rawName ?? '').toString();

  const keyToken = randomBytes(32).toString('base64url');
  const keyPrefix = keyToken.slice(0, 8);
  const keyHash = hashToken(keyToken);
  const row = createApiKey(serviceAccountId, name, keyPrefix, keyHash, req.auth!.user!.id) as any;
  setApiKeyPermissions(row.id, normalized);

  res.status(201).json({
    api_key: keyToken,
    api_key_id: row.id,
    key_prefix: keyPrefix,
    name: row.name,
    service_account_id: row.service_account_id,
    permissions: normalized,
  });
});

adminRouter.delete('/api-keys/:id', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const raw = (req.params as any).id as string | string[];
  const id = Number.parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid api key id' });
    return;
  }
  const ok = revokeApiKey(id);
  if (!ok) {
    res.status(404).json({ error: 'API key not found or already revoked' });
    return;
  }
  res.json({ success: true });
});

adminRouter.get('/api-key-usage', (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  const raw = req.query.api_key_id as string | undefined;
  const apiKeyId = raw && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const offset = req.query.offset ? Number(req.query.offset) : undefined;
  res.json(listApiKeyUsage(apiKeyId, limit, offset));
});

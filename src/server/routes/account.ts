import { Router, Request, Response } from 'express';
import { createHash, randomBytes } from 'crypto';
import {
  createApiKey,
  createServiceAccount,
  deleteServiceAccountOwned,
  getDropById,
  getApiKeyPermissions,
  getServiceAccountById,
  getUserDropPermission,
  listApiKeysForOwner,
  listApiKeyUsageForOwner,
  listDrops,
  listDropsForOwnerAccess,
  listServiceAccounts,
  revokeApiKeyOwned,
  setApiKeyPermissions,
} from '../db/sqlite.js';
import { authEnabled, requireAuth } from '../auth.js';

export const accountRouter = Router();

function requireSession(req: Request, res: Response) {
  if (!authEnabled()) {
    res.status(404).json({ error: 'Not found' });
    return false;
  }
  if (!requireAuth(req, res)) return false;
  if (!req.auth?.user || req.auth.authType !== 'session') {
    res.status(403).json({ error: 'Session authentication required' });
    return false;
  }
  return true;
}

function sha256Hex(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function generateApiKey() {
  // Short prefix is shown in UI; full key is only returned once.
  const token = `rph_${randomBytes(24).toString('base64url')}`;
  return { token, keyPrefix: token.slice(0, 12) };
}

accountRouter.get('/drops', (req: Request, res: Response) => {
  if (!requireSession(req, res)) return;
  const user = req.auth!.user!;
  if (user.role === 'admin') {
    const drops = listDrops().map((d) => ({ id: d.id, name: d.name, created_at: d.created_at, can_ingest: 1, can_query: 1 }));
    res.json({ drops });
    return;
  }
  const drops = listDropsForOwnerAccess(user.id);
  res.json({ drops });
});

accountRouter.get('/service-accounts', (req: Request, res: Response) => {
  if (!requireSession(req, res)) return;
  res.json(listServiceAccounts(req.auth!.user!.id));
});

accountRouter.post('/service-accounts', (req: Request, res: Response) => {
  if (!requireSession(req, res)) return;
  try {
    const name = (req.body?.name ?? '').toString();
    const row = createServiceAccount(name, req.auth!.user!.id);
    res.status(201).json(row);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || 'Failed to create service account' });
  }
});

accountRouter.delete('/service-accounts/:id', (req: Request, res: Response) => {
  if (!requireSession(req, res)) return;
  const raw = (req.params as any).id as string | string[];
  const id = Number.parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid service account id' });
    return;
  }
  const ok = deleteServiceAccountOwned(id, req.auth!.user!.id);
  if (!ok) {
    res.status(404).json({ error: 'Service account not found' });
    return;
  }
  res.json({ success: true });
});

accountRouter.get('/api-keys', (req: Request, res: Response) => {
  if (!requireSession(req, res)) return;
  const raw = req.query.service_account_id ?? req.query.serviceAccountId;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const serviceAccountId =
    first !== undefined && first !== null && String(first).trim() !== '' ? Number.parseInt(String(first), 10) : undefined;
  if (serviceAccountId !== undefined && !Number.isFinite(serviceAccountId)) {
    res.status(400).json({ error: 'Invalid service_account_id' });
    return;
  }

  const keys = listApiKeysForOwner(req.auth!.user!.id, serviceAccountId);
  const withPerms = keys.map((k: any) => ({ ...k, permissions: getApiKeyPermissions(k.id) }));
  res.json(withPerms);
});

accountRouter.post('/api-keys', (req: Request, res: Response) => {
  if (!requireSession(req, res)) return;
  const user = req.auth!.user!;

  const serviceAccountIdRaw = req.body?.service_account_id ?? req.body?.serviceAccountId;
  const serviceAccountId = Number(serviceAccountIdRaw);
  if (!Number.isFinite(serviceAccountId) || serviceAccountId <= 0) {
    res.status(400).json({ error: 'service_account_id is required' });
    return;
  }

  const sa = getServiceAccountById(serviceAccountId);
  if (!sa || sa.created_by_user_id !== user.id) {
    res.status(404).json({ error: 'Service account not found' });
    return;
  }

  const requested = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
  const normalized = requested
    .map((p: any) => {
      const dropId = Number(p?.drop_id ?? p?.dropId ?? p?.drop);
      if (!Number.isFinite(dropId) || dropId <= 0) return null;
      const canIngest = Boolean(p?.can_ingest ?? p?.ingest ?? false);
      const canQuery = Boolean(p?.can_query ?? p?.query ?? false);
      if (!canIngest && !canQuery) return null;
      return { drop_id: Math.floor(dropId), can_ingest: canIngest, can_query: canQuery };
    })
    .filter(Boolean) as Array<{ drop_id: number; can_ingest: boolean; can_query: boolean }>;

  if (normalized.length === 0) {
    res.status(400).json({ error: 'At least one drop permission is required' });
    return;
  }

  for (const perm of normalized) {
    if (!getDropById(perm.drop_id)) {
      res.status(400).json({ error: `Drop not found: ${perm.drop_id}` });
      return;
    }
  }

  if (user.role !== 'admin') {
    for (const perm of normalized) {
      const allowed = getUserDropPermission(user.id, perm.drop_id);
      const canIngest = Boolean(allowed?.can_ingest);
      const canQuery = Boolean(allowed?.can_query);
      if (perm.can_ingest && !canIngest) {
        res.status(403).json({ error: `You do not have ingest access for drop ${perm.drop_id}` });
        return;
      }
      if (perm.can_query && !canQuery) {
        res.status(403).json({ error: `You do not have query access for drop ${perm.drop_id}` });
        return;
      }
    }
  }

  const { token, keyPrefix } = generateApiKey();
  const keyHash = sha256Hex(token);
  const name = req.body?.name === undefined ? null : (req.body?.name ?? null);

  try {
    const row = createApiKey(serviceAccountId, name ? String(name) : null, keyPrefix, keyHash, user.id) as any;
    setApiKeyPermissions(row.id, normalized);
    res.status(201).json({
      id: row.id,
      service_account_id: row.service_account_id,
      key_prefix: keyPrefix,
      api_key: token,
      created_at: row.created_at,
      permissions: getApiKeyPermissions(row.id),
    });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || 'Failed to create API key' });
  }
});

accountRouter.delete('/api-keys/:id', (req: Request, res: Response) => {
  if (!requireSession(req, res)) return;
  const raw = (req.params as any).id as string | string[];
  const id = Number.parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid API key id' });
    return;
  }
  const ok = revokeApiKeyOwned(id, req.auth!.user!.id);
  if (!ok) {
    res.status(404).json({ error: 'API key not found' });
    return;
  }
  res.json({ success: true });
});

accountRouter.get('/api-key-usage', (req: Request, res: Response) => {
  if (!requireSession(req, res)) return;
  const raw = req.query.api_key_id ?? req.query.apiKeyId;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const apiKeyId =
    first !== undefined && first !== null && String(first).trim() !== '' ? Number.parseInt(String(first), 10) : undefined;
  if (apiKeyId !== undefined && !Number.isFinite(apiKeyId)) {
    res.status(400).json({ error: 'Invalid api_key_id' });
    return;
  }
  const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
  const offset = req.query.offset === undefined ? undefined : Number(req.query.offset);
  const rows = listApiKeyUsageForOwner(
    req.auth!.user!.id,
    apiKeyId,
    Number.isFinite(limit as number) ? (limit as number) : undefined,
    Number.isFinite(offset as number) ? (offset as number) : undefined
  );
  res.json(rows);
});

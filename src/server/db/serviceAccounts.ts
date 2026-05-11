import { db, clampLimit, clampOffset } from './core.js';

export function listServiceAccounts(ownerUserId: string) {
  return db
    .prepare(
      `
      SELECT sa.id, sa.name, sa.created_by_user_id, sa.created_at, sa.updated_at,
             up.email as created_by_email
      FROM service_accounts sa
      LEFT JOIN user_profiles up ON up.user_id = sa.created_by_user_id
      WHERE sa.created_by_user_id = ?
      ORDER BY sa.created_at DESC
      `
    )
    .all(ownerUserId) as Array<{
    id: number;
    name: string;
    created_by_user_id: string;
    created_by_email: string | null;
    created_at: number;
    updated_at: number;
  }>;
}

export function createServiceAccount(name: string, createdByUserId: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Service account name is required');
  if (trimmed.length > 64) throw new Error('Service account name too long (max 64 chars)');

  const info = db
    .prepare(`INSERT INTO service_accounts (name, created_by_user_id) VALUES (?, ?)`)
    .run(trimmed, createdByUserId);
  const id = Number(info.lastInsertRowid);
  return db
    .prepare(
      `
        SELECT sa.id, sa.name, sa.created_by_user_id, sa.created_at, sa.updated_at,
               up.email as created_by_email
        FROM service_accounts sa
        LEFT JOIN user_profiles up ON up.user_id = sa.created_by_user_id
        WHERE sa.id = ?
      `
    )
    .get(id);
}

export function deleteServiceAccountOwned(id: number, ownerUserId: string) {
  return (
    db.prepare(`DELETE FROM service_accounts WHERE id = ? AND created_by_user_id = ?`).run(id, ownerUserId).changes > 0
  );
}

export function listApiKeys(serviceAccountId?: number) {
  const clause = serviceAccountId ? 'WHERE service_account_id = ?' : '';
  const stmt = db.prepare(
    `
      SELECT k.id, k.service_account_id, k.name, k.key_prefix, k.created_by_user_id, k.created_at, k.revoked_at,
             sa.name as service_account_name,
             up.email as created_by_email
      FROM api_keys k
      LEFT JOIN service_accounts sa ON sa.id = k.service_account_id
      LEFT JOIN user_profiles up ON up.user_id = k.created_by_user_id
      ${clause}
      ORDER BY k.created_at DESC
    `
  );
  return serviceAccountId ? stmt.all(serviceAccountId) : stmt.all();
}

export function listApiKeysForOwner(ownerUserId: string, serviceAccountId?: number) {
  const clause = serviceAccountId ? 'AND k.service_account_id = ?' : '';
  const stmt = db.prepare(
    `
      SELECT k.id, k.service_account_id, k.name, k.key_prefix, k.created_by_user_id, k.created_at, k.revoked_at,
             sa.name as service_account_name,
             up.email as created_by_email
      FROM api_keys k
      INNER JOIN service_accounts sa ON sa.id = k.service_account_id
      LEFT JOIN user_profiles up ON up.user_id = k.created_by_user_id
      WHERE sa.created_by_user_id = ?
      ${clause}
      ORDER BY k.created_at DESC
    `
  );
  return serviceAccountId ? stmt.all(ownerUserId, serviceAccountId) : stmt.all(ownerUserId);
}

export function getServiceAccountById(id: number) {
  return db
    .prepare(
      `
        SELECT sa.id, sa.name, sa.created_by_user_id, sa.created_at, sa.updated_at,
               up.email as created_by_email
        FROM service_accounts sa
        LEFT JOIN user_profiles up ON up.user_id = sa.created_by_user_id
        WHERE sa.id = ?
      `
    )
    .get(id) as
    | {
        id: number;
        name: string;
        created_by_user_id: string;
        created_by_email: string | null;
        created_at: number;
        updated_at: number;
      }
    | undefined;
}

export function createApiKey(
  serviceAccountId: number,
  name: string | null,
  keyPrefix: string,
  keyHash: string,
  createdByUserId: string
) {
  const info = db
    .prepare(
      `
        INSERT INTO api_keys (service_account_id, name, key_prefix, key_hash, created_by_user_id)
        VALUES (?, ?, ?, ?, ?)
      `
    )
    .run(serviceAccountId, name, keyPrefix, keyHash, createdByUserId);
  const id = Number(info.lastInsertRowid);
  return db
    .prepare(
      `
        SELECT id, service_account_id, name, key_prefix, created_by_user_id, created_at, revoked_at
        FROM api_keys
        WHERE id = ?
      `
    )
    .get(id);
}

export function revokeApiKey(id: number) {
  return (
    db
      .prepare(`UPDATE api_keys SET revoked_at = (unixepoch() * 1000) WHERE id = ? AND revoked_at IS NULL`)
      .run(id).changes > 0
  );
}

export function revokeApiKeyOwned(apiKeyId: number, ownerUserId: string) {
  return (
    db
      .prepare(
        `
          UPDATE api_keys
          SET revoked_at = (unixepoch() * 1000)
          WHERE id = ?
            AND revoked_at IS NULL
            AND service_account_id IN (
              SELECT id FROM service_accounts WHERE created_by_user_id = ?
            )
        `
      )
      .run(apiKeyId, ownerUserId).changes > 0
  );
}

export function getApiKeyByHash(keyHash: string) {
  return db
    .prepare(
      `
        SELECT id, service_account_id, name, key_prefix, created_by_user_id, created_at, revoked_at
        FROM api_keys
        WHERE key_hash = ?
      `
    )
    .get(keyHash) as
    | {
        id: number;
        service_account_id: number;
        name: string | null;
        key_prefix: string;
        created_by_user_id: string;
        created_at: number;
        revoked_at: number | null;
      }
    | undefined;
}

export function setApiKeyPermissions(
  apiKeyId: number,
  permissions: Array<{ drop_id: number; can_ingest: boolean; can_query: boolean }>
) {
  const stmt = db.prepare(
    `
      INSERT INTO api_key_permissions (api_key_id, drop_id, can_ingest, can_query)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(api_key_id, drop_id) DO UPDATE SET
        can_ingest = excluded.can_ingest,
        can_query = excluded.can_query
    `
  );
  const tx = db.transaction((rows: typeof permissions) => {
    for (const row of rows) {
      stmt.run(apiKeyId, row.drop_id, row.can_ingest ? 1 : 0, row.can_query ? 1 : 0);
    }
  });
  tx(permissions);
}

export function getApiKeyPermissions(apiKeyId: number) {
  return db
    .prepare(
      `
        SELECT api_key_id, drop_id, can_ingest, can_query
        FROM api_key_permissions
        WHERE api_key_id = ?
      `
    )
    .all(apiKeyId) as Array<{
    api_key_id: number;
    drop_id: number;
    can_ingest: number;
    can_query: number;
  }>;
}

export function logApiKeyUsage(entry: {
  api_key_id: number;
  drop_id: number | null;
  method: string;
  path: string;
  status_code: number;
  ip_address?: string | null;
  user_agent?: string | null;
}) {
  db.prepare(
    `
      INSERT INTO api_key_usage (api_key_id, drop_id, method, path, status_code, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    entry.api_key_id,
    entry.drop_id,
    entry.method,
    entry.path,
    entry.status_code,
    entry.ip_address ?? null,
    entry.user_agent ?? null
  );
}

export function listApiKeyUsage(apiKeyId?: number, limit = 200, offset = 0) {
  const lim = clampLimit(limit);
  const off = clampOffset(offset);
  const clause = apiKeyId ? 'WHERE u.api_key_id = ?' : '';
  const stmt = db.prepare(
    `
      SELECT u.id, u.api_key_id, u.drop_id, u.method, u.path, u.status_code, u.ip_address, u.user_agent, u.created_at,
             k.key_prefix, k.name as api_key_name,
             sa.name as service_account_name
      FROM api_key_usage u
      LEFT JOIN api_keys k ON k.id = u.api_key_id
      LEFT JOIN service_accounts sa ON sa.id = k.service_account_id
      ${clause}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `
  );
  return apiKeyId ? stmt.all(apiKeyId, lim, off) : stmt.all(lim, off);
}

export function listApiKeyUsageForOwner(ownerUserId: string, apiKeyId?: number, limit = 200, offset = 0) {
  const lim = clampLimit(limit);
  const off = clampOffset(offset);
  const clause = apiKeyId ? 'AND u.api_key_id = ?' : '';
  const stmt = db.prepare(
    `
      SELECT u.id, u.api_key_id, u.drop_id, u.method, u.path, u.status_code, u.ip_address, u.user_agent, u.created_at,
             k.key_prefix, k.name as api_key_name,
             sa.name as service_account_name
      FROM api_key_usage u
      INNER JOIN api_keys k ON k.id = u.api_key_id
      INNER JOIN service_accounts sa ON sa.id = k.service_account_id
      WHERE sa.created_by_user_id = ?
      ${clause}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `
  );
  return apiKeyId ? stmt.all(ownerUserId, apiKeyId, lim, off) : stmt.all(ownerUserId, lim, off);
}


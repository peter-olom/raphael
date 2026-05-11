import { db } from './core.js';

export type UserRole = 'admin' | 'member';

export function countUserProfiles() {
  const row = db.prepare(`SELECT COUNT(*) as count FROM user_profiles`).get() as { count: number };
  return row.count;
}

export function countAdminProfiles() {
  const row = db
    .prepare(`SELECT COUNT(*) as count FROM user_profiles WHERE role = ? AND disabled = 0`)
    .get('admin') as { count: number };
  return row.count;
}

export function getUserProfile(userId: string) {
  return db
    .prepare(
      `
        SELECT user_id, email, role, disabled, created_at, updated_at, last_login_at
        FROM user_profiles
        WHERE user_id = ?
      `
    )
    .get(userId) as
    | {
        user_id: string;
        email: string;
        role: UserRole;
        disabled: number;
        created_at: number;
        updated_at: number;
        last_login_at: number | null;
      }
    | undefined;
}

export function listUserProfiles() {
  return db
    .prepare(
      `
        SELECT user_id, email, role, disabled, created_at, updated_at, last_login_at
        FROM user_profiles
        ORDER BY created_at DESC
      `
    )
    .all() as Array<{
    user_id: string;
    email: string;
    role: UserRole;
    disabled: number;
    created_at: number;
    updated_at: number;
    last_login_at: number | null;
  }>;
}

export function deleteSessionsForUsers(userIds: string[]) {
  if (userIds.length === 0) return 0;
  const stmt = db.prepare(`DELETE FROM session WHERE userId = ?`);
  const tx = db.transaction((ids: string[]) => {
    let count = 0;
    for (const id of ids) {
      count += stmt.run(id).changes;
    }
    return count;
  });
  return tx(userIds) as number;
}

export function upsertUserProfile(params: {
  user_id: string;
  email: string;
  role?: UserRole;
  disabled?: boolean;
  last_login_at?: number;
}) {
  const now = Date.now();
  const existing = getUserProfile(params.user_id);
  if (!existing) {
    const role = params.role ?? 'member';
    const disabled = params.disabled ? 1 : 0;
    db.prepare(
      `
        INSERT INTO user_profiles (user_id, email, role, disabled, created_at, updated_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    ).run(params.user_id, params.email.toLowerCase(), role, disabled, now, now, params.last_login_at ?? now);
  } else {
    const role = params.role ?? existing.role;
    const disabled = params.disabled === undefined ? existing.disabled : params.disabled ? 1 : 0;
    db.prepare(
      `
        UPDATE user_profiles
        SET email = ?,
            role = ?,
            disabled = ?,
            updated_at = (unixepoch() * 1000),
            last_login_at = COALESCE(?, last_login_at)
        WHERE user_id = ?
      `
    ).run(params.email.toLowerCase(), role, disabled, params.last_login_at ?? null, params.user_id);
  }
  return getUserProfile(params.user_id);
}

export function createUserProfileIfMissing(params: { user_id: string; email: string; role: UserRole }) {
  const existing = getUserProfile(params.user_id);
  if (existing) return existing;
  const now = Date.now();
  db.prepare(
    `
      INSERT INTO user_profiles (user_id, email, role, disabled, created_at, updated_at, last_login_at)
      VALUES (?, ?, ?, 0, ?, ?, NULL)
    `
  ).run(params.user_id, params.email.toLowerCase(), params.role, now, now);
  return getUserProfile(params.user_id);
}

export function updateUserRole(userId: string, role: UserRole) {
  db.prepare(
    `
      UPDATE user_profiles
      SET role = ?,
          updated_at = (unixepoch() * 1000)
      WHERE user_id = ?
    `
  ).run(role, userId);
}

export function updateUserDisabled(userId: string, disabled: boolean) {
  db.prepare(
    `
      UPDATE user_profiles
      SET disabled = ?,
          updated_at = (unixepoch() * 1000)
      WHERE user_id = ?
    `
  ).run(disabled ? 1 : 0, userId);
}

export function listUserDropPermissions(userId: string) {
  return db
    .prepare(
      `
        SELECT user_id, drop_id, can_ingest, can_query, created_at, updated_at
        FROM user_drop_permissions
        WHERE user_id = ?
      `
    )
    .all(userId) as Array<{
    user_id: string;
    drop_id: number;
    can_ingest: number;
    can_query: number;
    created_at: number;
    updated_at: number;
  }>;
}

export function getUserDropPermission(userId: string, dropId: number) {
  return db
    .prepare(
      `
        SELECT user_id, drop_id, can_ingest, can_query
        FROM user_drop_permissions
        WHERE user_id = ? AND drop_id = ?
      `
    )
    .get(userId, dropId) as
    | { user_id: string; drop_id: number; can_ingest: number; can_query: number }
    | undefined;
}

export function listDropsForOwnerAccess(ownerUserId: string) {
  return db
    .prepare(
      `
        SELECT d.id, d.name, d.label, d.created_at,
               p.can_ingest, p.can_query
        FROM user_drop_permissions p
        INNER JOIN drops d ON d.id = p.drop_id
        WHERE p.user_id = ?
          AND (p.can_ingest = 1 OR p.can_query = 1)
        ORDER BY d.created_at DESC
      `
    )
    .all(ownerUserId) as Array<{
    id: number;
    name: string;
    label: string | null;
    created_at: number;
    can_ingest: number;
    can_query: number;
  }>;
}

export function setUserDropPermissions(
  userId: string,
  permissions: Array<{ drop_id: number; can_ingest: boolean; can_query: boolean }>
) {
  const insert = db.prepare(
    `
      INSERT INTO user_drop_permissions (user_id, drop_id, can_ingest, can_query, updated_at)
      VALUES (?, ?, ?, ?, (unixepoch() * 1000))
    `
  );
  const clear = db.prepare(`DELETE FROM user_drop_permissions WHERE user_id = ?`);
  const tx = db.transaction((rows: typeof permissions) => {
    clear.run(userId);
    for (const row of rows) {
      if (!row.can_ingest && !row.can_query) continue;
      insert.run(userId, row.drop_id, row.can_ingest ? 1 : 0, row.can_query ? 1 : 0);
    }
  });
  tx(permissions);
}

export function hasAnyUserDropPermissions(userId: string) {
  const row = db
    .prepare(
      `
        SELECT 1 as ok
        FROM user_drop_permissions
        WHERE user_id = ?
        LIMIT 1
      `
    )
    .get(userId) as { ok: number } | undefined;
  return Boolean(row?.ok);
}

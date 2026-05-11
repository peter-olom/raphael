import { db } from './core.js';

export function listDashboards(dropId: number) {
  return db
    .prepare(
      `
        SELECT id, drop_id, name, spec_json, created_at, updated_at
        FROM dashboards
        WHERE drop_id = ?
        ORDER BY updated_at DESC
      `
    )
    .all(dropId);
}

export function getDashboard(dropId: number, dashboardId: number) {
  return db
    .prepare(
      `
        SELECT id, drop_id, name, spec_json, created_at, updated_at
        FROM dashboards
        WHERE drop_id = ? AND id = ?
      `
    )
    .get(dropId, dashboardId);
}

export function createDashboard(dropId: number, name: string, specJson: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Dashboard name is required');
  const info = db
    .prepare(
      `
        INSERT INTO dashboards (drop_id, name, spec_json)
        VALUES (?, ?, ?)
      `
    )
    .run(dropId, trimmed, specJson);
  return getDashboard(dropId, Number(info.lastInsertRowid));
}

export function updateDashboard(dropId: number, dashboardId: number, name?: string, specJson?: string) {
  const existing = getDashboard(dropId, dashboardId) as any;
  if (!existing) return null;

  const nextName = name === undefined ? existing.name : name.toString().trim();
  if (!nextName) throw new Error('Dashboard name is required');
  const nextSpec = specJson === undefined ? existing.spec_json : specJson;

  db.prepare(
    `
      UPDATE dashboards
      SET name = ?,
          spec_json = ?,
          updated_at = (unixepoch() * 1000)
      WHERE drop_id = ? AND id = ?
    `
  ).run(nextName, nextSpec, dropId, dashboardId);

  return getDashboard(dropId, dashboardId);
}

export function deleteDashboard(dropId: number, dashboardId: number) {
  return db.prepare(`DELETE FROM dashboards WHERE drop_id = ? AND id = ?`).run(dropId, dashboardId).changes > 0;
}


import { db } from './core.js';

export function getAppSetting(key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setAppSetting(key: string, value: string) {
  db.prepare(
    `
      INSERT INTO app_settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = (unixepoch() * 1000)
    `
  ).run(key, value);
}

export function deleteAppSetting(key: string) {
  db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(key);
}


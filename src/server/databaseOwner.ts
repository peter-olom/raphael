import Database from 'better-sqlite3';
import { accessSync, constants, existsSync, mkdirSync, realpathSync } from 'fs';
import path from 'path';
import { DB_PATH } from './paths.js';

let owner: Database.Database | null = null;
export function acquireDatabaseOwner() {
  if (owner) return;
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const canonical = existsSync(DB_PATH) ? realpathSync(DB_PATH) : path.join(realpathSync(path.dirname(DB_PATH)), path.basename(DB_PATH));
  // Set the native SQLite environment before opening any connection. Full VACUUM
  // uses temporary files and must not consume a small container /tmp tmpfs.
  const tempDirectory = path.resolve(process.env.SQLITE_TMPDIR || `${canonical}.tmp`);
  mkdirSync(tempDirectory, { recursive: true, mode: 0o700 });
  accessSync(tempDirectory, constants.W_OK);
  process.env.SQLITE_TMPDIR = realpathSync(tempDirectory);
  const connection = new Database(`${canonical}.owner.sqlite`, { timeout: 0 });
  try {
    // Keep this file permanently. Native SQLite file locks survive namespace differences,
    // and the OS releases the exclusive lease on process death. Never unlink a held lock.
    connection.pragma('journal_mode = DELETE');
    connection.exec('CREATE TABLE IF NOT EXISTS database_owner (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');
    owner = connection;
  } catch (error) {
    connection.close();
    throw new Error('Another Raphael process owns this database, or its owner lease cannot be acquired', { cause: error });
  }
  process.once('exit', releaseDatabaseOwner);
}
export function releaseDatabaseOwner() {
  if (!owner) return;
  try { owner.exec('ROLLBACK'); owner.close(); } catch {}
  owner = null;
}

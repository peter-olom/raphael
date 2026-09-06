import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const tempDir = mkdtempSync(path.join(tmpdir(), 'raphael-account-test-'));
process.env.RAPHAEL_DB_PATH = path.join(tempDir, 'raphael.db');
process.env.RAPHAEL_AUTH_ENABLED = 'true';
process.env.BETTER_AUTH_SECRET = 'local-regression-test-secret-only-123456789';
process.env.BETTER_AUTH_BASE_URL = 'http://localhost:6274';

// Import the application so its real schema and Better Auth options are used.
// Do not run Better Auth migrations: existing Raphael databases lack issuer.
const { getAuth } = await import('../src/server/auth.js');
const db = new Database(process.env.RAPHAEL_DB_PATH);

test.after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('existing GitHub accounts resolve on Raphael schema without issuer', async () => {
  const columns = db.prepare('PRAGMA table_info(account)').all() as Array<{ name: string }>;
  assert.equal(columns.some((column) => column.name === 'issuer'), false);

  const now = Date.now();
  db.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run('existing-user', 'Existing User', 'existing@example.test', 1, now, now);
  const insertAccount = db.prepare('INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)');
  insertAccount.run('existing-github', '123456', 'github', 'existing-user', now, now);
  insertAccount.run('other-provider', '123456', 'google', 'existing-user', now, now);

  const { internalAdapter } = await getAuth().$context;
  const key = { providerId: 'github', accountId: '123456' };
  // These are the library lookups used during OAuth sign-in and linking.
  const owner = await internalAdapter.findAccountOwnerByKey(key);
  assert.equal(owner?.kind, 'owned');
  assert.equal(owner?.user.id, 'existing-user');
  assert.equal(owner?.account.id, 'existing-github');
  const account = await internalAdapter.findAccountByKey(key);
  assert.equal(account?.id, 'existing-github');
  assert.equal(await internalAdapter.findAccountByKey({ ...key, accountId: 'missing' }), null);
  assert.equal((db.prepare('SELECT count(*) AS count FROM account').get() as { count: number }).count, 2);
});

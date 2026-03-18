const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

async function withTempDb(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-retention-'));
  const dbPath = path.join(dir, 'arena.db');

  delete process.env.DATABASE_URL;
  delete require.cache[require.resolve('../server/db')];
  const db = require('../server/db');
  await db.initDb(dbPath);

  try {
    await run(db);
  } finally {
    await db.closeDb();
    delete require.cache[require.resolve('../server/db')];
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('cleanupExpiredRecords purges expired sessions, expired connect sessions, and stale magic links', async () => {
  await withTempDb(async (db) => {
    const now = Date.now();
    const pastIso = new Date(now - (10 * 24 * 60 * 60 * 1000)).toISOString();
    const futureIso = new Date(now + (24 * 60 * 60 * 1000)).toISOString();

    await db.createAnonymousUser('user-1');
    await db.createSession('session-expired', 'user-1', 'expired-token', pastIso);
    await db.createSession('session-active', 'user-1', 'active-token', futureIso);

    await db.createConnectSessionRecord({
      id: 'connect-expired',
      ownerUserId: 'user-1',
      emailSnapshot: 'owner@example.com',
      status: 'pending_confirmation',
      callbackUrl: 'https://example.com/api/openclaw/callback',
      accessTokenHash: 'hash-expired-access',
      callbackProofHash: 'hash-expired-proof',
      createdAt: pastIso,
      expiresAt: pastIso,
    });
    await db.createConnectSessionRecord({
      id: 'connect-active',
      ownerUserId: 'user-1',
      emailSnapshot: 'owner@example.com',
      status: 'pending_confirmation',
      callbackUrl: 'https://example.com/api/openclaw/callback',
      accessTokenHash: 'hash-active-access',
      callbackProofHash: 'hash-active-proof',
      createdAt: futureIso,
      expiresAt: futureIso,
    });

    await db.createMagicLinkTokenRecord({
      tokenHash: 'magic-expired',
      userId: 'user-1',
      email: 'owner@example.com',
      expiresAt: pastIso,
    });
    await db.createMagicLinkTokenRecord({
      tokenHash: 'magic-consumed',
      userId: 'user-1',
      email: 'owner@example.com',
      expiresAt: futureIso,
    });
    await db.createMagicLinkTokenRecord({
      tokenHash: 'magic-active',
      userId: 'user-1',
      email: 'owner@example.com',
      expiresAt: futureIso,
    });
    const consumed = await db.consumeMagicLinkTokenRecord('magic-consumed');
    assert.ok(consumed);

    const deleted = await db.cleanupExpiredRecords({
      sessionGraceMs: 0,
      connectSessionGraceMs: 0,
      magicLinkGraceMs: 0,
      now: Date.now(),
    });

    assert.equal(deleted.sessions, 1);
    assert.equal(deleted.connectSessions, 1);
    assert.equal(deleted.magicLinkTokens, 2);

    const activeSession = await db.getSessionByToken('active-token');
    assert.ok(activeSession);
    assert.equal(activeSession.token ?? null, null);
    assert.equal(typeof activeSession.token_hash, 'string');
    assert.notEqual(activeSession.token_hash, 'active-token');

    const activeConnectSession = await db.getConnectSessionRecord('connect-active');
    assert.ok(activeConnectSession);
    assert.equal(activeConnectSession.id, 'connect-active');

    const removedConnectSession = await db.getConnectSessionRecord('connect-expired');
    assert.equal(removedConnectSession, null);

    const activeMagicLink = await db.consumeMagicLinkTokenRecord('magic-active');
    assert.ok(activeMagicLink);
    assert.equal(activeMagicLink.token_hash, 'magic-active');

    const removedMagicLink = await db.consumeMagicLinkTokenRecord('magic-expired');
    assert.equal(removedMagicLink, null);
  });
});

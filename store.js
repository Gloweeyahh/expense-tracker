/**
 * All database access lives here — server.js never writes SQL
 * directly. Two things worth noticing:
 *
 * - Every expense function takes userId as its first real argument
 *   and filters by it. There is no "get expense by id alone" function
 *   anywhere in this file — on purpose, so it's structurally
 *   impossible for a route to forget the ownership check by calling
 *   the wrong function. See README, "How cross-user isolation is
 *   enforced."
 * - createExpense() never does "check if it exists, then insert" —
 *   it inserts, and if that violates the UNIQUE(user_id,
 *   idempotency_key) constraint, it looks up and returns the row
 *   that's already there. Same reasoning as library-loans' double-
 *   lending prevention: a check-then-insert has a race condition a
 *   database constraint doesn't.
 */

function createUser(db, { email, passwordHash, passwordSalt }) {
  const stmt = db.prepare(
    'INSERT INTO users (email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?)'
  );
  const result = stmt.run(email, passwordHash, passwordSalt, new Date().toISOString());
  return { id: Number(result.lastInsertRowid), email };
}

function findUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}

function findUserById(db, id) {
  const row = db.prepare('SELECT id, email FROM users WHERE id = ?').get(id);
  return row || null;
}

function createSession(db, userId, tokenHash, expiresAt) {
  db.prepare('INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(userId, tokenHash, new Date().toISOString(), expiresAt);
}

/** Returns the user_id for a valid, unexpired session, or null. */
function findUserIdByTokenHash(db, tokenHash) {
  const row = db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
    .get(tokenHash);
  if (!row) return null;
  if (new Date(row.expires_at) <= new Date()) return null;
  return row.user_id;
}

function shapeExpense(row) {
  return {
    id: row.id,
    description: row.description,
    amount_cents: row.amount_cents,
    paid_at: row.paid_at,
    created_at: row.created_at,
  };
}

/**
 * Inserts an expense, or — if this user has already used this exact
 * idempotency key — returns the expense that insert originally
 * created. `created` tells the caller which one happened, so
 * server.js can answer 201 vs 200.
 */
function createExpense(db, userId, { description, amountCents, paidAt, idempotencyKey }) {
  try {
    const stmt = db.prepare(`
      INSERT INTO expenses (user_id, description, amount_cents, paid_at, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(userId, description, amountCents, paidAt, idempotencyKey, new Date().toISOString());
    const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(result.lastInsertRowid));
    return { expense: shapeExpense(row), created: true };
  } catch (err) {
    if (!String(err.message).includes('UNIQUE constraint failed')) throw err;
    const existing = db
      .prepare('SELECT * FROM expenses WHERE user_id = ? AND idempotency_key = ?')
      .get(userId, idempotencyKey);
    return { expense: shapeExpense(existing), created: false };
  }
}

function listExpenses(db, userId) {
  return db
    .prepare('SELECT * FROM expenses WHERE user_id = ? ORDER BY paid_at DESC')
    .all(userId)
    .map(shapeExpense);
}

/** Returns null if the expense does not exist OR belongs to a different user — the two cases are indistinguishable on purpose. */
function getExpense(db, userId, id) {
  const row = db.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').get(id, userId);
  return row ? shapeExpense(row) : null;
}

function deleteExpense(db, userId, id) {
  const result = db.prepare('DELETE FROM expenses WHERE id = ? AND user_id = ?').run(id, userId);
  return result.changes > 0;
}

module.exports = {
  createUser,
  findUserByEmail,
  findUserById,
  createSession,
  findUserIdByTokenHash,
  createExpense,
  listExpenses,
  getExpense,
  deleteExpense,
};

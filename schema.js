/**
 * Three tables:
 *   users    — one row per account
 *   sessions — one row per issued login token (see auth.js)
 *   expenses — one row per recorded payment, owned by exactly one user
 *
 * The one constraint that matters most for this brief:
 * UNIQUE(user_id, idempotency_key) on expenses. See README, "How
 * repeats are recognised," for why a client-supplied key — not
 * content matching — is the right tool for payments specifically.
 */

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  paid_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses(user_id, paid_at DESC);
`;

module.exports = { SCHEMA_SQL };

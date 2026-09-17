/**
 * expense-tracker — plain Node `http` + `node:sqlite`. No framework,
 * no ORM, no auth library — see README for the reasoning throughout.
 */

const http = require('http');
const { openDatabase } = require('./db');
const { hashPassword, verifyPassword, generateToken, hashToken, SESSION_LIFETIME_MS } = require('./auth');
const {
  validateSignupBody, validateLoginBody, validateExpenseBody, validateIdempotencyKey,
} = require('./validate');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const db = openDatabase();

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 100_000) {
        reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  let raw;
  try {
    raw = await readBody(req);
  } catch {
    return { error: { field: 'body', message: 'request body is too large or unreadable' } };
  }
  try {
    return { value: raw.length ? JSON.parse(raw) : {} };
  } catch {
    return { error: { field: 'body', message: 'request body must be valid JSON' } };
  }
}

/**
 * Extracts and validates the bearer token. Returns a user id on
 * success. On failure, sends the 401 itself and returns null — every
 * protected route just does `if (!userId) return;` after calling
 * this, so there's exactly one place unauthenticated access is
 * rejected, not one check per route that could be forgotten.
 */
function requireAuth(req, res) {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    sendJson(res, 401, { field: 'authorization', message: 'missing or malformed Authorization header — expected "Bearer <token>"' });
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    sendJson(res, 401, { field: 'authorization', message: 'missing or malformed Authorization header — expected "Bearer <token>"' });
    return null;
  }
  const userId = store.findUserIdByTokenHash(db, hashToken(token));
  if (!userId) {
    sendJson(res, 401, { field: 'authorization', message: 'token is invalid or expired — log in again' });
    return null;
  }
  return userId;
}

function isPositiveInteger(value) {
  return /^[1-9][0-9]*$/.test(value);
}

async function handleRequest(req, res) {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = pathname.split('/').filter(Boolean);

  if (pathname === '/' && req.method === 'GET') {
    return sendJson(res, 200, {
      service: 'expense-tracker',
      status: 'ok',
      endpoints: ['POST /signup', 'POST /login', 'GET /expenses', 'POST /expenses', 'GET /expenses/:id', 'DELETE /expenses/:id'],
    });
  }

  if (pathname === '/signup' && req.method === 'POST') {
    const { value: body, error } = await readJsonBody(req);
    if (error) return sendJson(res, 400, error);

    const validationError = validateSignupBody(body);
    if (validationError) return sendJson(res, 400, validationError);

    if (store.findUserByEmail(db, body.email)) {
      return sendJson(res, 409, { field: 'email', message: 'an account with this email already exists' });
    }

    const { hash, salt } = hashPassword(body.password);
    const user = store.createUser(db, { email: body.email, passwordHash: hash, passwordSalt: salt });

    const token = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS).toISOString();
    store.createSession(db, user.id, hashToken(token), expiresAt);

    return sendJson(res, 201, { token, user });
  }

  if (pathname === '/login' && req.method === 'POST') {
    const { value: body, error } = await readJsonBody(req);
    if (error) return sendJson(res, 400, error);

    const validationError = validateLoginBody(body);
    if (validationError) return sendJson(res, 400, validationError);

    const userRow = store.findUserByEmail(db, body.email);
    // Deliberately the same generic message whether the email doesn't
    // exist or the password is wrong — see README, "Why the login
    // error doesn't name a field," for why this is the one place in
    // the app that departs from naming the exact field.
    const invalidCredentials = { message: 'email or password is incorrect' };
    if (!userRow) return sendJson(res, 401, invalidCredentials);

    const valid = verifyPassword(body.password, userRow.password_hash, userRow.password_salt);
    if (!valid) return sendJson(res, 401, invalidCredentials);

    const token = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS).toISOString();
    store.createSession(db, userRow.id, hashToken(token), expiresAt);

    return sendJson(res, 200, { token, user: { id: userRow.id, email: userRow.email } });
  }

  if (pathname === '/expenses' && req.method === 'GET') {
    const userId = requireAuth(req, res);
    if (!userId) return;
    return sendJson(res, 200, { expenses: store.listExpenses(db, userId) });
  }

  if (pathname === '/expenses' && req.method === 'POST') {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const idempotencyCheck = validateIdempotencyKey(req.headers['idempotency-key']);
    if (idempotencyCheck.error) {
      return sendJson(res, 400, { field: 'Idempotency-Key', message: idempotencyCheck.error });
    }

    const { value: body, error } = await readJsonBody(req);
    if (error) return sendJson(res, 400, error);

    const validationError = validateExpenseBody(body);
    if (validationError) return sendJson(res, 400, validationError);

    const { expense, created } = store.createExpense(db, userId, {
      description: body.description,
      amountCents: body.amount_cents,
      paidAt: body.paid_at,
      idempotencyKey: idempotencyCheck.value,
    });
    return sendJson(res, created ? 201 : 200, expense);
  }

  if (parts.length === 2 && parts[0] === 'expenses') {
    const userId = requireAuth(req, res);
    if (!userId) return;

    const idParam = parts[1];
    if (!isPositiveInteger(idParam)) {
      return sendJson(res, 400, { field: 'id', message: 'expense id must be a positive integer' });
    }
    const id = Number(idParam);

    if (req.method === 'GET') {
      const expense = store.getExpense(db, userId, id);
      if (!expense) return sendJson(res, 404, { message: 'expense not found' });
      return sendJson(res, 200, expense);
    }

    if (req.method === 'DELETE') {
      const deleted = store.deleteExpense(db, userId, id);
      if (!deleted) return sendJson(res, 404, { message: 'expense not found' });
      res.writeHead(204);
      return res.end();
    }

    return sendJson(res, 405, { message: `method ${req.method} not allowed on /expenses/:id` });
  }

  return sendJson(res, 404, { message: 'not found' });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) {
      sendJson(res, 400, { field: null, message: 'request could not be processed' });
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`expense-tracker listening on port ${PORT}`);
  });
}

module.exports = server;

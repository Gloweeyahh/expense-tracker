/**
 * Starts the real server on a random free port and talks to it with
 * real HTTP requests via Node's built-in fetch. Two tests in here
 * matter more than the rest: "a user cannot read or write another
 * user's expense" and "the same create request sent twice leaves one
 * row" — both are exactly what this brief is checking for, so both
 * go through the actual HTTP layer end to end, not just the store
 * functions underneath it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'data', 'test-server.db');
process.env.DB_PATH = TEST_DB_PATH;
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB_PATH + suffix, { force: true });

const server = require('./server');

let baseUrl;

test.before(() => new Promise((resolve) => {
  server.listen(0, () => {
    baseUrl = `http://localhost:${server.address().port}`;
    resolve();
  });
}));

test.after(() => new Promise((resolve) => server.close(resolve)));

function req(p, options = {}) {
  return fetch(baseUrl + p, options);
}
function postJson(p, body, extraHeaders = {}) {
  return req(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
}
async function signup(email, password = 'a-good-password') {
  const res = await postJson('/signup', { email, password });
  const body = await res.json();
  return { token: body.token, userId: body.user.id, status: res.status };
}
function authed(token) {
  return { Authorization: `Bearer ${token}` };
}

test('GET / returns 200 with service info', async () => {
  const res = await req('/');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).service, 'expense-tracker');
});

test('GET /expenses with no Authorization header returns 401', async () => {
  const res = await req('/expenses');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.field, 'authorization');
});

test('GET /expenses with a garbage token returns 401, not 500', async () => {
  const res = await req('/expenses', { headers: authed('not-a-real-token') });
  assert.equal(res.status, 401);
});

test('GET /expenses with a malformed Authorization header (no "Bearer ") returns 401', async () => {
  const res = await req('/expenses', { headers: { Authorization: 'not-bearer-format' } });
  assert.equal(res.status, 401);
});

test('signing up creates an account and returns a usable token', async () => {
  const { token, status } = await signup('newuser1@example.com');
  assert.equal(status, 201);
  const res = await req('/expenses', { headers: authed(token) });
  assert.equal(res.status, 200);
});

test('signing up with an email already in use returns 409, naming the field', async () => {
  await signup('taken@example.com');
  const res = await postJson('/signup', { email: 'taken@example.com', password: 'another-password' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).field, 'email');
});

test('signing up with a short password returns 400, naming the field', async () => {
  const res = await postJson('/signup', { email: 'shortpw@example.com', password: 'short' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).field, 'password');
});

test('logging in with correct credentials returns a token', async () => {
  await postJson('/signup', { email: 'logintest@example.com', password: 'correct-password' });
  const res = await postJson('/login', { email: 'logintest@example.com', password: 'correct-password' });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).token);
});

test('logging in with the wrong password returns 401 with a generic message (not naming a field)', async () => {
  await postJson('/signup', { email: 'wrongpw@example.com', password: 'correct-password' });
  const res = await postJson('/login', { email: 'wrongpw@example.com', password: 'incorrect-password' });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.field, undefined);
  assert.match(body.message, /incorrect/);
});

test('logging in with an email that was never registered returns the SAME 401 message as a wrong password', async () => {
  const res = await req('/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'never-registered@example.com', password: 'whatever' }),
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(body.message, /incorrect/);
});

test('POST /expenses without an Idempotency-Key header returns 400 naming that field', async () => {
  const { token } = await signup('noidempkey@example.com');
  const res = await postJson('/expenses', { description: 'Coffee', amount_cents: 450, paid_at: '2026-09-15' }, authed(token));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).field, 'Idempotency-Key');
});

test('POST /expenses with an invalid body returns 400 naming the field', async () => {
  const { token } = await signup('badbody@example.com');
  const res = await postJson('/expenses', { amount_cents: 450, paid_at: '2026-09-15' }, { ...authed(token), 'Idempotency-Key': 'k1' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).field, 'description');
});

test('creating an expense returns 201 with the created row', async () => {
  const { token } = await signup('create1@example.com');
  const res = await postJson(
    '/expenses',
    { description: 'Groceries', amount_cents: 5600, paid_at: '2026-09-15' },
    { ...authed(token), 'Idempotency-Key': 'grocery-key-1' }
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.description, 'Groceries');
  assert.equal(body.amount_cents, 5600);
});

test('THE RETRY-SAFETY TEST: sending the same create request twice (same Idempotency-Key) leaves one row', async () => {
  const { token } = await signup('retrytest@example.com');
  const payload = { description: 'Rent', amount_cents: 150000, paid_at: '2026-09-01' };
  const headers = { ...authed(token), 'Idempotency-Key': 'rent-september' };

  const first = await postJson('/expenses', payload, headers);
  const second = await postJson('/expenses', payload, headers);

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);

  const firstBody = await first.json();
  const secondBody = await second.json();
  assert.equal(firstBody.id, secondBody.id);

  const list = await (await req('/expenses', { headers: authed(token) })).json();
  const matching = list.expenses.filter((e) => e.description === 'Rent');
  assert.equal(matching.length, 1);
});

test('THE CROSS-USER ISOLATION TEST: one user cannot read another user\'s expense', async () => {
  const alice = await signup('alice-isolation@example.com');
  const bob = await signup('bob-isolation@example.com');

  const created = await postJson(
    '/expenses',
    { description: "Alice's private expense", amount_cents: 999, paid_at: '2026-09-15' },
    { ...authed(alice.token), 'Idempotency-Key': 'alice-private-1' }
  );
  const aliceExpense = await created.json();

  // Bob, with his own VALID token, tries to read Alice's expense by id.
  const bobReadsAlices = await req(`/expenses/${aliceExpense.id}`, { headers: authed(bob.token) });
  assert.equal(bobReadsAlices.status, 404); // not 403 — see README for why

  // Bob's own list must not contain it either.
  const bobsList = await (await req('/expenses', { headers: authed(bob.token) })).json();
  assert.ok(!bobsList.expenses.some((e) => e.id === aliceExpense.id));

  // Alice can still read her own.
  const aliceReadsOwn = await req(`/expenses/${aliceExpense.id}`, { headers: authed(alice.token) });
  assert.equal(aliceReadsOwn.status, 200);
});

test('THE CROSS-USER ISOLATION TEST, part two: one user cannot delete another user\'s expense', async () => {
  const alice = await signup('alice-delete-test@example.com');
  const bob = await signup('bob-delete-test@example.com');

  const created = await postJson(
    '/expenses',
    { description: "Alice's expense, attempted deletion", amount_cents: 100, paid_at: '2026-09-15' },
    { ...authed(alice.token), 'Idempotency-Key': 'alice-delete-1' }
  );
  const aliceExpense = await created.json();

  const bobDeletesAlices = await req(`/expenses/${aliceExpense.id}`, { method: 'DELETE', headers: authed(bob.token) });
  assert.equal(bobDeletesAlices.status, 404);

  // It's still there, and Alice can still see it.
  const stillThere = await req(`/expenses/${aliceExpense.id}`, { headers: authed(alice.token) });
  assert.equal(stillThere.status, 200);
});

test('a user CAN delete their own expense', async () => {
  const { token } = await signup('ownscope-delete@example.com');
  const created = await postJson(
    '/expenses',
    { description: 'To be deleted', amount_cents: 100, paid_at: '2026-09-15' },
    { ...authed(token), 'Idempotency-Key': 'own-delete-1' }
  );
  const expense = await created.json();

  const del = await req(`/expenses/${expense.id}`, { method: 'DELETE', headers: authed(token) });
  assert.equal(del.status, 204);

  const after = await req(`/expenses/${expense.id}`, { headers: authed(token) });
  assert.equal(after.status, 404);
});

test('malformed JSON body returns 400, not 500', async () => {
  const { token } = await signup('malformedjson@example.com');
  const res = await req('/expenses', {
    method: 'POST',
    headers: { ...authed(token), 'Content-Type': 'application/json', 'Idempotency-Key': 'k1' },
    body: '{not valid json',
  });
  assert.equal(res.status, 400);
});

test('a malformed expense id returns 400, not 500', async () => {
  const { token } = await signup('badid@example.com');
  const res = await req('/expenses/not-a-number', { headers: authed(token) });
  assert.equal(res.status, 400);
});

test('an unknown route returns 404, not 500', async () => {
  const res = await req('/definitely/not/a/route');
  assert.equal(res.status, 404);
});

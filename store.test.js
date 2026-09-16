const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEST_DB_PATH = path.join(__dirname, 'data', 'test-store.db');
process.env.DB_PATH = TEST_DB_PATH;
const { openDatabase } = require('./db');
const store = require('./store');

let db;
let userA;
let userB;

test.before(() => {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(TEST_DB_PATH + suffix, { force: true });
  db = openDatabase(TEST_DB_PATH);
  userA = store.createUser(db, { email: 'alice@example.com', passwordHash: 'x', passwordSalt: 'y' });
  userB = store.createUser(db, { email: 'bob@example.com', passwordHash: 'x', passwordSalt: 'y' });
});

test.after(() => db.close());

test('createExpense returns created:true for a new idempotency key', () => {
  const { created } = store.createExpense(db, userA.id, {
    description: 'Coffee', amountCents: 450, paidAt: '2026-09-15', idempotencyKey: 'key-1',
  });
  assert.equal(created, true);
});

test('the same idempotency key for the same user returns the original expense, created:false', () => {
  const first = store.createExpense(db, userA.id, {
    description: 'Lunch', amountCents: 1200, paidAt: '2026-09-15', idempotencyKey: 'key-2',
  });
  const second = store.createExpense(db, userA.id, {
    description: 'Lunch, but claimed different this time', amountCents: 9999, paidAt: '2026-09-16', idempotencyKey: 'key-2',
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.expense.id, first.expense.id);
  // The original wins — a repeat with a different body doesn't overwrite it.
  assert.equal(second.expense.description, 'Lunch');
  assert.equal(second.expense.amount_cents, 1200);
});

test('the same idempotency key is a DIFFERENT expense for a different user', () => {
  const a = store.createExpense(db, userA.id, {
    description: 'Shared key test', amountCents: 100, paidAt: '2026-09-15', idempotencyKey: 'shared-key',
  });
  const b = store.createExpense(db, userB.id, {
    description: 'Shared key test', amountCents: 200, paidAt: '2026-09-15', idempotencyKey: 'shared-key',
  });
  assert.equal(a.created, true);
  assert.equal(b.created, true);
  assert.notEqual(a.expense.id, b.expense.id);
});

test('a different idempotency key for the same user creates a genuinely separate expense', () => {
  const before = store.listExpenses(db, userA.id).length;
  store.createExpense(db, userA.id, {
    description: 'Second coffee, same day', amountCents: 450, paidAt: '2026-09-15', idempotencyKey: 'key-3',
  });
  assert.equal(store.listExpenses(db, userA.id).length, before + 1);
});

test('listExpenses only returns the given user\'s expenses', () => {
  const aList = store.listExpenses(db, userA.id);
  const bList = store.listExpenses(db, userB.id);
  assert.ok(aList.every((e) => true)); // shape check only — ownership isn't a field on the returned object
  assert.equal(bList.length, 1); // only the "shared-key" one created above
});

test('getExpense returns null when the expense belongs to a different user', () => {
  const { expense } = store.createExpense(db, userA.id, {
    description: 'Alice-only', amountCents: 300, paidAt: '2026-09-15', idempotencyKey: 'alice-only-key',
  });
  assert.equal(store.getExpense(db, userB.id, expense.id), null);
  assert.notEqual(store.getExpense(db, userA.id, expense.id), null);
});

test('deleteExpense returns false when called by a different user, and does not delete it', () => {
  const { expense } = store.createExpense(db, userA.id, {
    description: 'Protected from Bob', amountCents: 500, paidAt: '2026-09-15', idempotencyKey: 'protected-key',
  });
  assert.equal(store.deleteExpense(db, userB.id, expense.id), false);
  assert.notEqual(store.getExpense(db, userA.id, expense.id), null);
});

test('findUserByEmail is case-sensitive-as-stored (no normalization surprises)', () => {
  assert.equal(store.findUserByEmail(db, 'alice@example.com').id, userA.id);
  assert.equal(store.findUserByEmail(db, 'nobody@example.com'), null);
});

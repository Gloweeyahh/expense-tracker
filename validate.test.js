const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateSignupBody, validateLoginBody, validateExpenseBody, validateIdempotencyKey,
} = require('./validate');

test('validateSignupBody accepts a valid signup', () => {
  assert.equal(validateSignupBody({ email: 'a@example.com', password: 'longenough' }), null);
});

test('validateSignupBody rejects a missing email', () => {
  assert.equal(validateSignupBody({ password: 'longenough' }).field, 'email');
});

test('validateSignupBody rejects a malformed email', () => {
  assert.equal(validateSignupBody({ email: 'not-an-email', password: 'longenough' }).field, 'email');
});

test('validateSignupBody rejects a password that is too short', () => {
  const err = validateSignupBody({ email: 'a@example.com', password: 'short' });
  assert.equal(err.field, 'password');
  assert.match(err.message, /at least/);
});

test('validateSignupBody rejects a missing password', () => {
  assert.equal(validateSignupBody({ email: 'a@example.com' }).field, 'password');
});

test('validateLoginBody requires both fields as non-empty strings', () => {
  assert.equal(validateLoginBody({}).field, 'email');
  assert.equal(validateLoginBody({ email: 'a@example.com' }).field, 'password');
  assert.equal(validateLoginBody({ email: 'a@example.com', password: 'x' }), null);
});

test('validateExpenseBody accepts a valid expense', () => {
  const err = validateExpenseBody({ description: 'Coffee', amount_cents: 450, paid_at: '2026-09-15' });
  assert.equal(err, null);
});

test('validateExpenseBody rejects a missing description', () => {
  assert.equal(validateExpenseBody({ amount_cents: 450, paid_at: '2026-09-15' }).field, 'description');
});

test('validateExpenseBody rejects amount_cents as a decimal', () => {
  const err = validateExpenseBody({ description: 'Coffee', amount_cents: 4.5, paid_at: '2026-09-15' });
  assert.equal(err.field, 'amount_cents');
});

test('validateExpenseBody rejects amount_cents as a string', () => {
  const err = validateExpenseBody({ description: 'Coffee', amount_cents: '450', paid_at: '2026-09-15' });
  assert.equal(err.field, 'amount_cents');
});

test('validateExpenseBody rejects a zero or negative amount', () => {
  assert.equal(validateExpenseBody({ description: 'Coffee', amount_cents: 0, paid_at: '2026-09-15' }).field, 'amount_cents');
  assert.equal(validateExpenseBody({ description: 'Coffee', amount_cents: -50, paid_at: '2026-09-15' }).field, 'amount_cents');
});

test('validateExpenseBody rejects an unparseable paid_at', () => {
  const err = validateExpenseBody({ description: 'Coffee', amount_cents: 450, paid_at: 'not a date' });
  assert.equal(err.field, 'paid_at');
});

test('validateIdempotencyKey requires the header to be present', () => {
  assert.match(validateIdempotencyKey(undefined).error, /required/);
});

test('validateIdempotencyKey rejects an empty or whitespace-only key', () => {
  assert.ok(validateIdempotencyKey('').error);
  assert.ok(validateIdempotencyKey('   ').error);
});

test('validateIdempotencyKey accepts a normal key', () => {
  assert.equal(validateIdempotencyKey('a1b2c3').value, 'a1b2c3');
});

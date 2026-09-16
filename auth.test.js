const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, generateToken, hashToken } = require('./auth');

test('verifyPassword accepts the correct password', () => {
  const { hash, salt } = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', hash, salt), true);
});

test('verifyPassword rejects a wrong password', () => {
  const { hash, salt } = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('wrong password entirely', hash, salt), false);
});

test('verifyPassword rejects a password that only differs by one character', () => {
  const { hash, salt } = hashPassword('correct-horse-battery-staple');
  assert.equal(verifyPassword('correct-horse-battery-staplE', hash, salt), false);
});

test('hashPassword produces a different hash for the same password on different calls (random salt)', () => {
  const a = hashPassword('same password');
  const b = hashPassword('same password');
  assert.notEqual(a.hash, b.hash);
  assert.notEqual(a.salt, b.salt);
  // but both still verify correctly against their own salt
  assert.equal(verifyPassword('same password', a.hash, a.salt), true);
  assert.equal(verifyPassword('same password', b.hash, b.salt), true);
});

test('generateToken produces different tokens on repeated calls', () => {
  const tokens = new Set();
  for (let i = 0; i < 100; i++) tokens.add(generateToken());
  assert.equal(tokens.size, 100);
});

test('hashToken is deterministic — the same token always hashes the same way', () => {
  const token = generateToken();
  assert.equal(hashToken(token), hashToken(token));
});

test('hashToken produces different hashes for different tokens', () => {
  assert.notEqual(hashToken(generateToken()), hashToken(generateToken()));
});

test('hashToken does not just return the token unchanged', () => {
  const token = generateToken();
  assert.notEqual(hashToken(token), token);
});

/**
 * Validation, kept separate from HTTP and storage so it can be tested
 * without a server or a database. Every function returns null when
 * valid, or { field, message } naming exactly what's wrong — that
 * shape is what server.js sends back as the 400 response body.
 */

const MAX_EMAIL_LENGTH = 254; // the actual limit from the email spec, not a guess
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200; // capped before it ever reaches scrypt — see auth.js
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_AMOUNT_CENTS = 100_000_000; // $1,000,000 — a sanity ceiling, not a real limit
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

// Not a full RFC 5322 parser — just "there's an @ with something on
// both sides, and a dot somewhere after it." Good enough to catch
// typos without rejecting real addresses a stricter regex might.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateSignupBody(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { field: 'body', message: 'request body must be a JSON object' };
  }
  const { email, password } = body;

  if (email === undefined) return { field: 'email', message: 'email is required' };
  if (typeof email !== 'string') return { field: 'email', message: 'email must be a string' };
  if (email.length > MAX_EMAIL_LENGTH) return { field: 'email', message: `email must be ${MAX_EMAIL_LENGTH} characters or fewer` };
  if (!EMAIL_RE.test(email)) return { field: 'email', message: 'email must be a valid email address' };

  if (password === undefined) return { field: 'password', message: 'password is required' };
  if (typeof password !== 'string') return { field: 'password', message: 'password must be a string' };
  if (password.length < MIN_PASSWORD_LENGTH) return { field: 'password', message: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  if (password.length > MAX_PASSWORD_LENGTH) return { field: 'password', message: `password must be ${MAX_PASSWORD_LENGTH} characters or fewer` };

  return null;
}

function validateLoginBody(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { field: 'body', message: 'request body must be a JSON object' };
  }
  if (typeof body.email !== 'string' || body.email.length === 0) {
    return { field: 'email', message: 'email is required' };
  }
  if (typeof body.password !== 'string' || body.password.length === 0) {
    return { field: 'password', message: 'password is required' };
  }
  return null;
}

function validateExpenseBody(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { field: 'body', message: 'request body must be a JSON object' };
  }
  const { description, amount_cents, paid_at } = body;

  if (description === undefined) return { field: 'description', message: 'description is required' };
  if (typeof description !== 'string') return { field: 'description', message: 'description must be a string' };
  if (description.trim().length === 0) return { field: 'description', message: 'description must not be empty' };
  if (description.length > MAX_DESCRIPTION_LENGTH) return { field: 'description', message: `description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer` };

  if (amount_cents === undefined) return { field: 'amount_cents', message: 'amount_cents is required' };
  if (!Number.isInteger(amount_cents)) return { field: 'amount_cents', message: 'amount_cents must be a whole number of cents (e.g. 1050 for $10.50)' };
  if (amount_cents <= 0) return { field: 'amount_cents', message: 'amount_cents must be greater than zero' };
  if (amount_cents > MAX_AMOUNT_CENTS) return { field: 'amount_cents', message: `amount_cents must be ${MAX_AMOUNT_CENTS} or fewer` };

  if (paid_at === undefined) return { field: 'paid_at', message: 'paid_at is required' };
  if (typeof paid_at !== 'string') return { field: 'paid_at', message: 'paid_at must be a string' };
  if (Number.isNaN(Date.parse(paid_at))) return { field: 'paid_at', message: 'paid_at must be a valid date (e.g. "2026-09-15" or an ISO timestamp)' };

  return null;
}

function validateIdempotencyKey(raw) {
  if (raw === undefined) {
    return { error: 'Idempotency-Key header is required for this request' };
  }
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { error: 'Idempotency-Key must not be empty' };
  }
  if (raw.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return { error: `Idempotency-Key must be ${MAX_IDEMPOTENCY_KEY_LENGTH} characters or fewer` };
  }
  return { value: raw.trim() };
}

module.exports = {
  validateSignupBody,
  validateLoginBody,
  validateExpenseBody,
  validateIdempotencyKey,
  MIN_PASSWORD_LENGTH,
  MAX_AMOUNT_CENTS,
};

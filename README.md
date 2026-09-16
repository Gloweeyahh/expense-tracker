# expense-tracker

A personal expense tracker: sign up, log in, record what you paid for.
The domain is deliberately unremarkable — what this project is actually
about is three things every real service needs and gets wrong at least
once: accounts that can't see each other's data, a write that's safe to
retry, and errors a caller can actually act on.

Plain Node, using the built-in `node:sqlite` module. No framework, no
ORM, no auth library, no password-hashing package — see "No secret is
committed" below for why that's not just a style preference here.

**Live URL:** _add your deployed Render URL here before submitting_

## Endpoints

| Method | Path | Auth? | Success | Failure |
|---|---|---|---|---|
| `GET` | `/` | no | `200`, service info | — |
| `POST` | `/signup` | no | `201`, `{ token, user }` | `400` invalid input; `409` email taken |
| `POST` | `/login` | no | `200`, `{ token, user }` | `400` invalid input; `401` wrong credentials |
| `GET` | `/expenses` | yes | `200`, `{ expenses: [...] }` — only the caller's own | `401` |
| `POST` | `/expenses` | yes | `201` created, or `200` if this exact request was already handled | `400` invalid input; `401` |
| `GET` | `/expenses/:id` | yes | `200`, the expense | `400` bad id; `401`; `404` not found or not yours |
| `DELETE` | `/expenses/:id` | yes | `204` | `400` bad id; `401`; `404` not found or not yours |

"yes" under Auth means: send `Authorization: Bearer <token>`, the token
`/signup` or `/login` gave you. Missing or invalid → `401`.

## Accounts and authentication

`POST /signup` creates an account and immediately returns a session
token — no separate login step required right after signing up.
`POST /login` does the same for an existing account. Every other
endpoint requires that token in an `Authorization: Bearer <token>`
header.

**A request with no token, or a malformed one, gets `401` before it
touches any data** — `requireAuth()` in `server.js` is the single
choke point every protected route calls first; there's no route that
checks authorization on its own, which means there's no route that can
individually forget to.

## No secret is committed to the repository

This one's true by construction, not by carefulness: there is no
signing secret anywhere in this app. Sessions aren't JWTs — there's no
key that signs a token and could leak or need rotating. A session token
is 32 random bytes (`crypto.randomBytes`), and the database stores only
its SHA-256 hash, never the token itself — the same reason a password
database stores a hash, not the password: if the database leaked, the
hashes alone aren't usable as login tokens. Passwords are hashed with
`scrypt` and a random per-row salt generated at signup — no shared
"pepper" constant anywhere that would itself be a secret worth
protecting.

The only two things this service needs to run are `PORT` (which Render
sets itself) and where to put its database file — neither is
sensitive, and neither is committed. There's genuinely nothing to put
in an env var that isn't already safe to read in the source.

## How cross-user isolation is enforced

Every function in `store.js` that touches an expense takes `userId` as
its first argument and filters by it in the SQL itself:

```sql
SELECT * FROM expenses WHERE id = ? AND user_id = ?
```

There is no `getExpenseById(id)` anywhere in this codebase — on
purpose. If that function existed, some future route could call it
without thinking to check ownership afterward, and the bug would be a
one-line omission that's easy to miss in review. Making the
owner-scoped query the *only* query that exists means a route can't
accidentally skip the check — there's no unscoped path to accidentally
take.

When a lookup or delete targets somebody else's row, the response is a
plain **`404`, not `403`**. A `403` confirms the row exists and simply
isn't yours; a `404` doesn't tell an attacker whether id `47` belongs
to someone else or doesn't exist at all. Same reasoning as the `404`s
in `bookmark-service` and `library-loans` — consistent across this
whole set of projects, not a one-off choice here.

**This is tested directly, end to end, through real HTTP requests** —
`server.test.js` has two tests explicitly named for this: one creates
two real accounts, has user B attempt to `GET` user A's expense by id
with B's own valid token, and asserts `404` plus asserts A's expense
never appears in B's list; the other does the same for `DELETE` and
confirms the row still exists afterward. These aren't incidental —
they're the two tests this whole brief is centered on.

## How repeats are recognised

`POST /expenses` requires an `Idempotency-Key` header. The same key,
sent twice by the same user, returns the *original* expense with
`200` — the second request does not create a second row. This is
enforced by `UNIQUE (user_id, idempotency_key)` in the schema:
`createExpense()` in `store.js` just inserts, and if that insert
collides with a key already used, it looks up and returns the row
that's already there instead. Same "insert and let the constraint
catch the collision" pattern as `library-loans`' double-lending
prevention, for the same reason: a check-then-insert has a race
between the two steps that a database constraint doesn't.

**This is a different idempotency strategy than `bookmark-service`
used, on purpose** — worth being explicit about why, since the two
domains genuinely call for different answers:

- In `bookmark-service`, two creates count as "the same" when they
  share a URL. That's correct there because a bookmark *is* its URL —
  there's no legitimate reason to have the same URL saved twice.
- Here, content matching would be **wrong**. Two payments with the
  same description and amount on the same day — two separate $5
  coffees — are not duplicates. They're just two payments that happen
  to look alike. The only thing that can tell them apart is something
  the *client* knows and the server can't infer: whether this is a
  retry of a request already sent, or a brand new one. That's exactly
  what a client-generated `Idempotency-Key` (a UUID, generated once
  per logical action and reused only on retry) is for — the same
  pattern real payment APIs use, for the same reason.

**This is tested end to end too** — `server.test.js` sends the same
create request twice with the same key, checks the first is `201` and
the second is `200` with the same id, then confirms `GET /expenses`
shows exactly one row.

## Errors name what's wrong

Every `400` response has the shape `{ field, message }` — which field,
and what to do about it. `POST /expenses` missing `description` comes
back `{"field":"description","message":"description is required"}`,
not a bare `400` or a stack trace.

**One deliberate exception:** `POST /login` with a wrong password and
`POST /login` with an email that was never registered return the exact
same response — `401`, `{"message":"email or password is incorrect"}`,
no `field`. This is the one place in the app that doesn't pinpoint a
specific field, and that's intentional: if "email not found" and
"wrong password" gave different messages, that difference would let
anyone check, email by email, which addresses have an account here —
a real information leak in production login systems. The message
still says what to do (double-check both), it just declines to say
*which one* was wrong, for a security reason that outweighs the
general rule everywhere else in this app.

## Password and token hashing, and why they're different

- **Passwords** use `scrypt` — slow and memory-hard on purpose, because
  a password is something a person chose, which means it's often
  short, common, or reused, and needs to be expensive to brute-force
  even if the database leaks.
- **Session tokens** use plain `SHA-256` — because a token isn't
  something a person chose, it's 32 cryptographically random bytes
  this server generated. It's already far too high-entropy to
  brute-force, so hashing it with something slow would only add real
  CPU cost to every authenticated request for no actual security
  benefit. SHA-256 just needs to make a leaked database not directly
  reusable as valid login tokens.

Password comparison uses `crypto.timingSafeEqual`, not `===` — a
straightforward `===` on two hashes leaks timing information about how
many leading bytes matched, which is a real (if narrow) attack against
naive comparison code.

## What's deliberately not implemented

- **Logout / token revocation.** A token is valid until it expires (30
  days) — there's no endpoint to invalidate one early. A real version
  would need a revocation check on every request, which is a
  meaningful design decision (a blocklist? shortened expiry with
  refresh tokens?) left for later rather than bolted on quickly.
- **Password reset.** Needs email delivery, which is a whole
  dependency and a whole new way for this to fail, out of scope here.
- **Editing an expense.** Only create, read, list, and delete — an
  edit endpoint raises its own idempotency question (is an edit retry-
  safe the same way a create is?) that deserves its own thinking, not
  a quick add.
- **Rate limiting** on `/login` or `/signup`. Nothing currently slows
  down repeated guesses beyond scrypt's own cost.
- **Multi-currency.** Amounts are just integer cents; there's no
  currency field at all.

## Running it locally

```
node server.js
```

No install step. Try it:

```
curl -X POST http://localhost:3000/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"a-good-password"}'
```

Use the `token` from that response for everything else:

```
curl -X POST http://localhost:3000/expenses \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: <any unique string, e.g. a UUID>" \
  -H "Content-Type: application/json" \
  -d '{"description":"Coffee","amount_cents":450,"paid_at":"2026-09-15"}'
```

## Running the checks

```
node --test
```

Four files, 51 tests total: `auth.test.js` and `validate.test.js` (pure
logic, no database or server), `store.test.js` (the idempotency and
ownership-scoping logic directly against the database), and
`server.test.js` (the real server, real HTTP requests — including the
two isolation tests and the retry-safety test described above).

A passing run ends with:

```
# tests 51
# suites 0
# pass 51
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## Deploying

Same approach as the rest of this portfolio:
[Render](https://render.com)'s free tier, no credit card, connects
straight to GitHub.

1. Push this repo to GitHub.
2. Render: **New → Web Service** → connect the repo.
3. Build command: leave blank.
4. Start command: `node --no-warnings server.js`.
5. Deploy.

Nothing to configure — no environment variables need setting, because
there are no secrets (see above). Free-tier services sleep after 15
minutes idle and take 30-60 seconds to wake on the next request.

## Files

- `schema.js` — users, sessions, expenses, and the retry-safety constraint
- `db.js` — opens the database, applies schema
- `auth.js` — password hashing, token generation and hashing
- `validate.js` — input validation for signup, login, and expenses
- `store.js` — all database access; every expense function is owner-scoped
- `server.js` — HTTP routing, the auth check, and every endpoint
- `auth.test.js`, `validate.test.js`, `store.test.js`, `server.test.js` — automated checks

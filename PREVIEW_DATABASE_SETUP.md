# Database and Preview safety

The production `wrangler.toml` in this repository points to the live D1 database shared with the manager Pages project.

## Current environment policy

- Do not create another D1 database unless the owner explicitly changes this requirement.
- The Cloudflare Preview bindings currently point to the same production D1 database. Therefore Preview is **not** an isolated test environment.
- Do not run migrations, seed scripts, destructive SQL, or functional traffic tests against either Pages Preview URL while that binding remains unchanged.
- Continue verification with the isolated local D1 fixture and GitHub Actions only.
- Do not run `wrangler d1 migrations apply` with the production `wrangler.toml`.

## Customer-code allocation contract

- `landing_code_counters.slug` stores the configured **customer-code prefix**, not the landing-link slug. The historical column name is retained for schema compatibility.
- Links that use the same prefix share one counter.
- Different prefixes have separate counters.
- The generated customer code is `<prefix>/-<sequence>`.
- `customer_code_sessions.customer_code` is globally unique, and `wa_assignments.customer_code` is globally unique. Do not change these constraints to per-link uniqueness.
- Reusing a prefix across links continues the same sequence so a customer code cannot collide globally.

## Schema ownership

The visitor project's versioned D1 migration provisions the queue, session, assignment, number-pool, route-state, refill-lock, and unique-event tables. Runtime API requests must not create or alter tables. Apply schema changes only through a reviewed migration in an isolated local test database first.

## Production protection

No production D1 migration, SQL write, binding change, or deployment is part of this repair branch.

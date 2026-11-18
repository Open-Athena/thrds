-- @open-athena/thrds D1 / SQLite schema: slot state (`d1Store`) and hosted avatars (`d1AvatarStore`).
-- Copy into a wrangler migration (or run on a local SQLite db). Kept equal to `SCHEMA` in `src/d1.ts` by tests/stores.test.ts.
CREATE TABLE IF NOT EXISTS thrds_slots (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  lease TEXT,
  lease_until INTEGER,
  dirty INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS public_avatars (
  sha256 TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

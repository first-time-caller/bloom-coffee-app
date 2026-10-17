-- Representative rows valid for the schema after 0001_init.sql. Applied before migration 0002 and every later one;
-- the data-preservation test asserts they survive unchanged. Tables not listed here get generated rows.
INSERT INTO users (id, email, name, pw_hash, seq, created_at) VALUES
  ('u1', 'ada@example.com', 'Ada', 'pbkdf2$sha256$100000$c2FsdA$aGFzaA', 3, '2026-01-02T03:04:05.000Z'),
  ('u2', 'grace@example.com', '', 'pbkdf2$sha256$100000$c2FsdA$aGFzaA', 0, '2026-01-03T03:04:05.000Z');
INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, expires_at) VALUES
  ('aa11', 'u1', 1767323045000, 1767323045000, 1769915045000);
INSERT INTO docs (user_id, collection, id, data, deleted, updated_at, seq) VALUES
  ('u1', 'history', 'rec-1', '{"id":"rec-1","method":"v60","rating":4}', 0, '2026-01-02T03:04:05.000Z', 1),
  ('u1', 'history', 'rec-2', NULL, 1, '2026-01-02T03:05:05.000Z', 2),
  ('u1', '_root', 'settings', '{"pro":true}', 0, '2026-01-02T03:06:05.000Z', 3);
INSERT INTO shots (user_id, machine_id, shot_id, data, size, meta, created_at, updated_at) VALUES
  ('u1', 'gm-1', '42', x'00010203fffe', 6, '{"profileName":"Classic 9 bar"}', '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z');
INSERT INTO rate_limits (key, window_start, count) VALUES ('login:1.2.3.4', 1767323045000, 2);

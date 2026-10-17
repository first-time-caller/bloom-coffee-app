-- Bloom backend schema v2: end-to-end encryption. ADDITIVE ONLY (no drops, renames or type changes).
--
-- The server never sees a password, master key, key-encryption key, data key or recovery key.
-- It stores what the client uploads: a hash of the client-derived authKey (in the existing users.pw_hash column),
-- the key-derivation parameters (so they can be raised later), and two wrapped copies of the data key.
-- docs.data now holds an opaque envelope {"v":1,"iv":"..","ct":".."}; shots.data holds "BSE\x01"|iv|ciphertext.
-- shots.meta is no longer written (metadata is not sent to the server); the column is kept for old rows.
ALTER TABLE users ADD COLUMN kdf_alg              TEXT;      -- 'pbkdf2-sha256'
ALTER TABLE users ADD COLUMN kdf_iterations       INTEGER;   -- >= 600000 for new accounts
ALTER TABLE users ADD COLUMN kdf_salt             TEXT;      -- base64url, client generated, public
ALTER TABLE users ADD COLUMN wrapped_dek          TEXT;      -- JSON envelope: AES-GCM(kek, dek)
ALTER TABLE users ADD COLUMN recovery_wrapped_dek TEXT;      -- JSON envelope: AES-GCM(recoveryKek, dek)
ALTER TABLE users ADD COLUMN recovery_hash        TEXT;      -- pbkdf2 hash of the client-derived recoveryAuth
ALTER TABLE users ADD COLUMN key_version          INTEGER NOT NULL DEFAULT 1;

-- Small key/value table for server-side secrets generated on first use (e.g. the prelogin decoy key).
CREATE TABLE server_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

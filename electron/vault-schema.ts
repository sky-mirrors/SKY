export const VAULT_SCHEMA = `
CREATE TABLE IF NOT EXISTS kv_store (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  encrypted INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, key)
);

CREATE TABLE IF NOT EXISTS vectors (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  metadata TEXT,
  embedding BLOB,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, key)
);

CREATE TABLE IF NOT EXISTS vault_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kv_namespace ON kv_store(namespace);
CREATE INDEX IF NOT EXISTS idx_kv_updated ON kv_store(updated_at);
CREATE INDEX IF NOT EXISTS idx_vectors_namespace ON vectors(namespace);
`

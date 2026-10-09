export const OFFLINE_ROW_SQL = `CREATE TABLE IF NOT EXISTS offline_row (
  resource TEXT NOT NULL,
  id TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (resource, id)
)`;

export const OFFLINE_PENDING_SQL = `CREATE TABLE IF NOT EXISTS offline_pending (
  server_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (server_id, client_id, seq)
)`;

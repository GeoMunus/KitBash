// Database schema, embedded so the server needs no extra files at runtime. Applied in order at startup; each is recorded in
// schema_migrations and never re-run. Timestamps everywhere are epoch milliseconds.
export const MIGRATIONS = [
  { name: '0001_workspace', sql: `-- Kitbash Workspace schema. All timestamps are epoch milliseconds.

CREATE TABLE agents (
  id          TEXT PRIMARY KEY,               -- stable identity used in every record ('claude', 'chatgpt', ...)
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,                  -- owner | claude | chatgpt | openai-api | custom
  description TEXT NOT NULL DEFAULT '',
  scopes      TEXT NOT NULL DEFAULT '["read","write"]',  -- ceiling for any token bound to this agent
  enabled     INTEGER NOT NULL DEFAULT 1,
  connectable INTEGER NOT NULL DEFAULT 1,     -- may an OAuth client be bound to this agent at consent?
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER
);

CREATE TABLE files (
  path       TEXT PRIMARY KEY,
  rev        INTEGER NOT NULL,
  format     TEXT NOT NULL DEFAULT 'text/plain',   -- opaque tag, e.g. ntree/manifest, ntn/config, kitbash/part
  encoding   TEXT NOT NULL DEFAULT 'utf8',         -- utf8 | base64
  content    TEXT NOT NULL,
  meta       TEXT NOT NULL DEFAULT '{}',           -- provenance / original name / anything the importer wants to keep
  owner      TEXT NOT NULL,                        -- agent id with default write authority
  deleted    INTEGER NOT NULL DEFAULT 0,
  size       INTEGER NOT NULL,
  sha        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE file_revs (
  path        TEXT NOT NULL,
  rev         INTEGER NOT NULL,
  content     TEXT NOT NULL,
  format      TEXT NOT NULL,
  encoding    TEXT NOT NULL,
  meta        TEXT NOT NULL,
  author      TEXT NOT NULL,
  approved_by TEXT,
  message     TEXT,
  op          TEXT NOT NULL DEFAULT 'write',       -- write | delete | restore | proposal
  sha         TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  PRIMARY KEY (path, rev)                          -- the PK is what makes concurrent writers conflict instead of overwrite
);

CREATE TABLE leases (
  path        TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  task_id     INTEGER,
  acquired_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',        -- open | in_progress | review | blocked | done | cancelled
  assignee    TEXT,
  created_by  TEXT NOT NULL,
  files       TEXT NOT NULL DEFAULT '[]',          -- paths this task authorises its assignee to claim
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  sender    TEXT NOT NULL,                         -- always set by the server from the authenticated identity
  recipient TEXT NOT NULL DEFAULT 'all',
  kind      TEXT NOT NULL DEFAULT 'chat',          -- chat | note | review | handoff | system
  body      TEXT NOT NULL,
  task_id   INTEGER,
  meta      TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE approvals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,                      -- proposal | delete_file | restore_checkpoint
  payload      TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | rejected | stale
  decided_by   TEXT,
  decided_at   INTEGER,
  result       TEXT,
  ts           INTEGER NOT NULL
);

CREATE TABLE checkpoints (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT NOT NULL,
  created_by TEXT NOT NULL,
  manifest   TEXT NOT NULL,                        -- {path: rev}; contents live in file_revs
  ts         INTEGER NOT NULL
);

CREATE TABLE audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  actor  TEXT NOT NULL,
  via    TEXT NOT NULL DEFAULT '',                 -- the token identity that carried the call (differs from actor for owner-key calls)
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE owner_attempts (ts INTEGER NOT NULL, ok INTEGER NOT NULL);

CREATE INDEX idx_messages_ts ON messages (id);
CREATE INDEX idx_approvals_status ON approvals (status, id);
CREATE INDEX idx_tasks_assignee ON tasks (assignee, status);
CREATE INDEX idx_audit_ts ON audit (id);

-- Agent registry seed. Future agents are added with the owner-only register_agent tool.
INSERT INTO agents (id, name, kind, description, scopes, enabled, connectable, created_at) VALUES
  ('owner',      'You (owner)',        'owner',      'The project owner. Approves destructive operations.',            '["read","write"]', 1, 0, 0),
  ('claude',     'Claude',             'claude',     'Claude, in Kitbash or via a claude.ai connector.',                '["read","write"]', 1, 1, 0),
  ('chatgpt',    'ChatGPT',            'chatgpt',    'ChatGPT through a remote MCP connector (needs plan support).',    '["read","write"]', 1, 1, 0),
  ('openai-api', 'OpenAI agent',       'openai-api', 'Embedded agent run by the Worker through the OpenAI API.',        '["read","write"]', 1, 0, 0);
` },
  { name: '0002_oauth', sql: `-- OAuth 2.1 authorization server state (Node/Railway only). Secrets are stored as SHA-256 hashes, never in the clear.
CREATE TABLE oauth_clients (
  client_id  TEXT PRIMARY KEY,
  info       TEXT NOT NULL,                 -- registered client metadata (JSON, from dynamic client registration)
  created_at INTEGER NOT NULL
);
CREATE TABLE oauth_pending (                -- an authorization request waiting for the owner to approve it on the consent page
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  params     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE oauth_codes (
  code_hash  TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource   TEXT,
  actor      TEXT NOT NULL,                 -- the agent identity the owner chose at consent; copied into tokens, never supplied by a caller
  scopes     TEXT NOT NULL,
  grant_id   TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                 -- access | refresh
  grant_id   TEXT NOT NULL,
  client_id  TEXT NOT NULL,
  actor      TEXT NOT NULL,
  scopes     TEXT NOT NULL,
  resource   TEXT,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id);
` }
];

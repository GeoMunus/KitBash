// SQLite storage for Railway, using the SQLite that ships inside Node (node:sqlite, Node 22.13+). No native modules to compile.
// It exposes the small slice of the Cloudflare D1 API that service.js uses (prepare/bind/first/all/run/batch), so the same
// tested workspace logic runs here unchanged. batch() is one atomic transaction, which is what makes conflicting writes
// fail cleanly instead of overwriting each other.
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './schema.js';

let DatabaseSync;
try { ({ DatabaseSync } = await import('node:sqlite')); }
catch (e) { throw new Error(`This server needs Node 22.13 or newer (node:sqlite is missing on ${process.version}). Railway: set the service's Node version to 22 or 24 (package.json "engines" already asks for it).`); }

const arg = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const plain = (row) => (row ? { ...row } : null);
const reads = (sql) => /^\s*(select|with|pragma)\b/i.test(sql);

class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.db, this.sql, args); }
  _sync() {
    const st = this.db.prepare(this.sql); const a = this.args.map(arg);
    if (reads(this.sql)) return { success: true, results: st.all(...a).map(plain), meta: { changes: 0, last_row_id: 0 } };
    const r = st.run(...a); return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async first(col) { const st = this.db.prepare(this.sql); const row = plain(st.get(...this.args.map(arg))); return row ? (col ? row[col] : row) : null; }
  async all() { return this._sync(); }
  async run() { return this._sync(); }
}

class D1Like {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Statement(this.db, sql); }
  /** All statements succeed or none do. Nothing else can interleave: the whole batch runs synchronously. */
  async batch(statements) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = statements.map((s) => s._sync()); this.db.exec('COMMIT'); return out; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
  }
  async exec(sql) { this.db.exec(sql); }
}

/** Where the database file lives. On Railway, attach a Volume and this resolves inside it automatically. */
export function resolveDbPath(env = process.env) {
  if (env.DATABASE_PATH) return { file: path.resolve(env.DATABASE_PATH), persistent: !!env.RAILWAY_VOLUME_MOUNT_PATH && path.resolve(env.DATABASE_PATH).startsWith(path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH)), source: 'DATABASE_PATH' };
  if (env.RAILWAY_VOLUME_MOUNT_PATH) return { file: path.join(env.RAILWAY_VOLUME_MOUNT_PATH, 'kitbash.db'), persistent: true, source: 'Railway volume' };
  return { file: path.resolve('data', 'kitbash.db'), persistent: false, source: 'local ./data (not persistent on Railway)' };
}

export function openDatabase(env = process.env) {
  const loc = resolveDbPath(env);
  fs.mkdirSync(path.dirname(loc.file), { recursive: true });
  const db = new DatabaseSync(loc.file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const applied = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    db.exec('BEGIN');
    try { db.exec(m.sql); db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(m.name, Date.now()); db.exec('COMMIT'); applied.push(m.name); }
    catch (e) { db.exec('ROLLBACK'); throw new Error(`Migration ${m.name} failed: ${e.message}`); }
  }
  return { DB: new D1Like(db), raw: db, location: loc, applied };
}

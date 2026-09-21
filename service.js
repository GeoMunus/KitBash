// Workspace service layer. Every rule that protects agents from each other lives here,
// so the MCP tools, the OAuth screen and the embedded OpenAI agent all go through the same checks.

export class WsError extends Error {
  constructor(code, message, data = {}) { super(message); this.code = code; this.data = data; }
}

const LIMITS = { file: 500_000, message: 8_000, path: 200, title: 200, payload: 600_000, leaseSeconds: 1800, maxLeaseSeconds: 4 * 3600 };
const TASK_STATUS = ['open', 'in_progress', 'review', 'blocked', 'done', 'cancelled'];
const AGENT_KINDS = ['claude', 'chatgpt', 'openai-api', 'custom'];
const AGENT_KIND_SET = new Set(AGENT_KINDS);
const AGENT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/;
const j = (v) => JSON.stringify(v);
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const now = () => Date.now();

/** Bytes of a stored file body: UTF-8 for text, decoded bytes for base64. Fingerprints and sizes describe the ORIGINAL bytes. */
export function contentBytes(content, encoding = 'utf8') {
  if (encoding !== 'base64') return new TextEncoder().encode(content);
  const bin = atob(content.replace(/\s+/g, '')); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
}
export async function sha256(data) {
  const buf = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function normPath(p) {
  if (typeof p !== 'string') throw new WsError('bad_path', 'path must be a string');
  const s = p.trim();
  if (!s || s.length > LIMITS.path || !/^[A-Za-z0-9._\-\/ ]+$/.test(s) || s.startsWith('/') || s.endsWith('/') || s.split('/').some((seg) => seg === '..' || seg === '.' || seg === ''))
    throw new WsError('bad_path', 'path must be relative, use letters, digits, . _ - / and space, and contain no . or .. segments');
  return s;
}

/* ---------------- identity ---------------- */

async function timingSafeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256('k:' + a), sha256('k:' + b)]);
  let d = 0; for (let i = 0; i < ha.length; i++) d |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return d === 0;
}

export async function verifyOwnerKey(env, key) {
  if (!env.OWNER_SECRET || String(env.OWNER_SECRET).length < 8) throw new WsError('server_misconfigured', 'OWNER_SECRET is not set (min 8 characters)');
  const since = now() - 10 * 60_000;
  const fails = await env.DB.prepare('SELECT COUNT(*) AS n FROM owner_attempts WHERE ok = 0 AND ts > ?').bind(since).first();
  if (fails.n >= 10) throw new WsError('locked_out', 'Too many wrong owner keys. Try again in ten minutes.');
  const ok = typeof key === 'string' && key.length > 0 && (await timingSafeEqual(key, String(env.OWNER_SECRET)));
  await env.DB.prepare('INSERT INTO owner_attempts (ts, ok) VALUES (?, ?)').bind(now(), ok ? 1 : 0).run();
  if (ok) await env.DB.prepare('DELETE FROM owner_attempts WHERE ts <= ?').bind(since).run();
  return ok;
}

export async function getAgent(env, id) {
  const r = await env.DB.prepare('SELECT * FROM agents WHERE id = ?').bind(id).first();
  return r ? { ...r, scopes: parse(r.scopes, []), enabled: !!r.enabled, connectable: !!r.connectable } : null;
}
export async function listAgents(env) {
  const { results } = await env.DB.prepare('SELECT * FROM agents ORDER BY created_at, id').all();
  return results.map((r) => ({ ...r, scopes: parse(r.scopes, []), enabled: !!r.enabled, connectable: !!r.connectable }));
}

/**
 * Build the caller context from the verified token props (set only by the consent screen)
 * and an optional owner key. The actor can never come from tool arguments.
 */
export async function resolveCtx(env, props, ownerKey) {
  // The owner's own browser session. Only server.js can set owner_session, and only after checking the owner key on that very request;
  // OAuth tokens never carry it (their props come from the consent screen).
  if (props && props.owner_session === true) return { env, actor: 'owner', via: 'owner-ui', isOwner: true, scopes: new Set(['read', 'write']) };
  const via = props && props.actor;
  const agent = via ? await getAgent(env, via) : null;
  if (!agent || !agent.connectable) throw new WsError('unauthorized', 'This token is not bound to a connectable agent identity');
  if (!agent.enabled) throw new WsError('agent_disabled', `Agent ${agent.id} is disabled by the owner`);
  const tokenScopes = new Set((props.scopes || []).filter((s) => agent.scopes.includes(s)));
  await env.DB.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').bind(now(), agent.id).run();
  if (ownerKey !== undefined && ownerKey !== null && ownerKey !== '') {
    if (!(await verifyOwnerKey(env, ownerKey))) throw new WsError('bad_owner_key', 'Owner key rejected');
    return { env, actor: 'owner', via, isOwner: true, scopes: new Set(['read', 'write']) };
  }
  return { env, actor: agent.id, via, isOwner: false, scopes: tokenScopes };
}
/** Context used by server-side actors (the embedded agent) — identity is fixed in code, not supplied by a caller. */
export async function serverCtx(env, agentId) {
  const agent = await getAgent(env, agentId);
  if (!agent || !agent.enabled) throw new WsError('agent_disabled', `Agent ${agentId} is missing or disabled`);
  return { env, actor: agent.id, via: 'server', isOwner: false, scopes: new Set(agent.scopes) };
}
export async function ownerCtxFromKey(env, props, ownerKey) {
  const ctx = await resolveCtx(env, props, ownerKey);
  if (!ctx.isOwner) throw new WsError('owner_required', 'This action needs the owner key');
  return ctx;
}

const need = (ctx, scope) => { if (!ctx.scopes.has(scope)) throw new WsError('forbidden', `This connection lacks the ${scope} scope`); };
const needOwner = (ctx) => { if (!ctx.isOwner) throw new WsError('owner_required', 'Only the owner can do this. Agents may request it as an approval instead.'); };

async function audit(ctx, action, target, detail = {}) {
  await ctx.env.DB.prepare('INSERT INTO audit (ts, actor, via, action, target, detail) VALUES (?,?,?,?,?,?)').bind(now(), ctx.actor, ctx.via || '', action, target == null ? null : String(target), j(detail)).run();
}
async function systemMessage(env, body, taskId = null, recipient = 'all', kind = 'system', sender = 'system') {
  await env.DB.prepare('INSERT INTO messages (ts, sender, recipient, kind, body, task_id) VALUES (?,?,?,?,?,?)').bind(now(), sender, recipient, kind, body.slice(0, LIMITS.message), taskId).run();
}
async function assertKnownAgent(env, id, { allowOwner = false, allowAll = false } = {}) {
  if (allowAll && id === 'all') return;
  const a = await getAgent(env, id);
  if (!a || !a.enabled || (!allowOwner && a.kind === 'owner')) throw new WsError('unknown_agent', `Unknown or disabled agent: ${id}`);
}

/* ---------------- files ---------------- */

const fileRow = (r) => r && ({ path: r.path, rev: r.rev, format: r.format, encoding: r.encoding, size: r.size, sha: r.sha, owner: r.owner, deleted: !!r.deleted, updated_at: r.updated_at, updated_by: r.updated_by, meta: parse(r.meta, {}) });

async function liveLease(env, path) {
  const l = await env.DB.prepare('SELECT * FROM leases WHERE path = ?').bind(path).first();
  if (!l) return null;
  if (l.expires_at <= now()) { await env.DB.prepare('DELETE FROM leases WHERE path = ? AND expires_at = ?').bind(path, l.expires_at).run(); return null; }
  return l;
}

export async function listFiles(ctx, { prefix = '', include_deleted = false } = {}) {
  need(ctx, 'read');
  const { results } = await ctx.env.DB.prepare('SELECT * FROM files WHERE path LIKE ? ' + (include_deleted ? '' : 'AND deleted = 0 ') + 'ORDER BY path LIMIT 500').bind(prefix.replace(/[%_]/g, '') + '%').all();
  const leases = (await ctx.env.DB.prepare('SELECT * FROM leases WHERE expires_at > ?').bind(now()).all()).results;
  const byPath = Object.fromEntries(leases.map((l) => [l.path, { holder: l.holder, task_id: l.task_id, expires_at: l.expires_at }]));
  return results.map((r) => ({ ...fileRow(r), lease: byPath[r.path] || null }));
}

export async function readFile(ctx, { path, rev } = {}) {
  need(ctx, 'read'); path = normPath(path);
  const cur = await ctx.env.DB.prepare('SELECT * FROM files WHERE path = ?').bind(path).first();
  if (!cur) throw new WsError('not_found', `No such file: ${path}`);
  let r = cur;
  if (rev !== undefined && rev !== null && rev !== cur.rev) {
    r = await ctx.env.DB.prepare('SELECT * FROM file_revs WHERE path = ? AND rev = ?').bind(path, rev).first();
    if (!r) throw new WsError('not_found', `No revision ${rev} of ${path}`);
  }
  const lease = await liveLease(ctx.env, path);
  return { path, rev: r.rev, current_rev: cur.rev, format: r.format, encoding: r.encoding, content: r.content, sha: r.sha, meta: parse(r.meta, {}), owner: cur.owner, deleted: !!cur.deleted && r.rev === cur.rev, author: r.author ?? cur.updated_by, lease: lease ? { holder: lease.holder, task_id: lease.task_id, expires_at: lease.expires_at } : null };
}

export async function fileHistory(ctx, { path, limit = 50 } = {}) {
  need(ctx, 'read'); path = normPath(path);
  const { results } = await ctx.env.DB.prepare('SELECT rev, format, encoding, author, approved_by, message, op, sha, ts, length(content) AS size FROM file_revs WHERE path = ? ORDER BY rev DESC LIMIT ?').bind(path, Math.min(limit, 200)).all();
  if (!results.length) throw new WsError('not_found', `No such file: ${path}`);
  return results;
}

function canWrite(ctx, file, lease) {
  if (ctx.isOwner) return { ok: true };
  if (lease) return lease.holder === ctx.actor ? { ok: true } : { ok: false, code: 'locked', message: `${file.path} is leased by ${lease.holder} until ${new Date(lease.expires_at).toISOString()}` };
  if (file.owner === ctx.actor) return { ok: true };
  return { ok: false, code: 'not_owner', message: `${file.path} is owned by ${file.owner}. Use propose_change, or ask ${file.owner} or the owner to hand it over.` };
}

function checkContent(content, encoding) {
  if (typeof content !== 'string') throw new WsError('bad_content', 'content must be a string');
  if (content.length > LIMITS.file) throw new WsError('too_large', `content exceeds ${LIMITS.file} characters`);
  if (!['utf8', 'base64'].includes(encoding)) throw new WsError('bad_encoding', 'encoding must be utf8 or base64');
  if (encoding === 'base64' && !/^[A-Za-z0-9+/]*={0,2}$/.test(content.replace(/\s+/g, ''))) throw new WsError('bad_content', 'content is not valid base64');
  if (encoding === 'base64') { try { atob(content.replace(/\s+/g, '')); } catch { throw new WsError('bad_content', 'content is not valid base64'); } }
}
const cleanMeta = (m) => { const s = j(m ?? {}); if (s.length > 20_000) throw new WsError('too_large', 'meta exceeds 20 KB'); return s; };

async function insertRevAndUpdate(ctx, { path, base_rev, content, format, encoding, meta, author, approved_by = null, message = null, op = 'write', owner, deleted = 0, created }) {
  const env = ctx.env; const rev = base_rev + 1; const ts = now(); const bytes = contentBytes(content, encoding); const sha = await sha256(bytes); const size = bytes.length;
  const insRev = env.DB.prepare('INSERT INTO file_revs (path, rev, content, format, encoding, meta, author, approved_by, message, op, sha, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(path, rev, content, format, encoding, meta, author, approved_by, message, op, sha, ts);
  const upd = created
    ? env.DB.prepare('INSERT INTO files (path, rev, format, encoding, content, meta, owner, deleted, size, sha, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(path, rev, format, encoding, content, meta, owner, deleted, size, sha, ts, ts, author)
    : env.DB.prepare('UPDATE files SET rev = ?, format = ?, encoding = ?, content = ?, meta = ?, deleted = ?, size = ?, sha = ?, updated_at = ?, updated_by = ? WHERE path = ? AND rev = ?').bind(rev, format, encoding, content, meta, deleted, size, sha, ts, author, path, base_rev);
  try {
    const res = await env.DB.batch([insRev, upd]);
    if (!created && res[1].meta.changes !== 1) throw new Error('stale');
  } catch (e) {
    const cur = await env.DB.prepare('SELECT rev, sha, updated_by FROM files WHERE path = ?').bind(path).first();
    throw new WsError('conflict', `${path} changed while you were writing (now rev ${cur ? cur.rev : '?'}). Nothing was overwritten.`, { current_rev: cur && cur.rev, current_sha: cur && cur.sha, updated_by: cur && cur.updated_by });
  }
  return { path, rev, sha };
}

export async function writeFile(ctx, { path, content, base_rev, format, encoding, meta, message } = {}) {
  need(ctx, 'write'); path = normPath(path);
  if (!Number.isInteger(base_rev) || base_rev < 0) throw new WsError('bad_base_rev', 'base_rev is required: 0 to create a file, otherwise the revision you last read');
  const cur = await ctx.env.DB.prepare('SELECT * FROM files WHERE path = ?').bind(path).first();
  const enc = encoding ?? (cur ? cur.encoding : 'utf8'); checkContent(content, enc);
  const fmt = (format ?? (cur ? cur.format : 'text/plain')).slice(0, 80);
  const m = cleanMeta(meta ?? (cur ? parse(cur.meta, {}) : {}));
  if (!cur) {
    if (base_rev !== 0) throw new WsError('conflict', `${path} does not exist (base_rev must be 0 to create it)`, { current_rev: 0 });
    const r = await insertRevAndUpdate(ctx, { path, base_rev: 0, content, format: fmt, encoding: enc, meta: m, author: ctx.actor, message, owner: ctx.actor, created: true });
    await audit(ctx, 'file.create', path, { rev: r.rev, format: fmt }); return { ...r, created: true, owner: ctx.actor };
  }
  if (cur.rev !== base_rev) throw new WsError('conflict', `${path} is at rev ${cur.rev} but you wrote against rev ${base_rev}. Read it again and merge. Nothing was overwritten.`, { current_rev: cur.rev, current_sha: cur.sha, updated_by: cur.updated_by });
  const lease = await liveLease(ctx.env, path); const can = canWrite(ctx, cur, lease);
  if (!can.ok) throw new WsError(can.code, can.message, { owner: cur.owner, lease: lease && { holder: lease.holder, expires_at: lease.expires_at } });
  const r = await insertRevAndUpdate(ctx, { path, base_rev, content, format: fmt, encoding: enc, meta: m, author: ctx.actor, message, owner: cur.owner, deleted: 0 });
  await audit(ctx, 'file.write', path, { rev: r.rev, base_rev }); return { ...r, created: false, owner: cur.owner };
}

/* ---------------- approvals ---------------- */

async function createApproval(ctx, kind, payload, reason) {
  const s = j(payload); if (s.length > LIMITS.payload) throw new WsError('too_large', 'approval payload too large');
  const r = await ctx.env.DB.prepare('INSERT INTO approvals (kind, payload, requested_by, reason, ts) VALUES (?,?,?,?,?)').bind(kind, s, ctx.actor, (reason || '').slice(0, 1000), now()).run();
  const id = r.meta.last_row_id; await audit(ctx, 'approval.request', id, { kind });
  await systemMessage(ctx.env, `${ctx.actor} requested approval #${id}: ${kind}${payload.path ? ' ' + payload.path : ''}${reason ? ' — ' + reason : ''}`, null, 'owner');
  return id;
}

export async function proposeChange(ctx, { path, content, base_rev, rationale, format, encoding } = {}) {
  need(ctx, 'write'); path = normPath(path);
  const cur = await ctx.env.DB.prepare('SELECT * FROM files WHERE path = ?').bind(path).first();
  if (!cur) throw new WsError('not_found', `No such file: ${path}. Create new files with write_file.`);
  if (!Number.isInteger(base_rev)) throw new WsError('bad_base_rev', 'base_rev is required');
  const enc = encoding ?? cur.encoding; checkContent(content, enc);
  const id = await createApproval(ctx, 'proposal', { path, base_rev, content, format: (format ?? cur.format).slice(0, 80), encoding: enc, sha: await sha256(contentBytes(content, enc)) }, rationale);
  return { approval_id: id, status: 'pending', note: 'Nothing was changed. The owner must approve this.' };
}
export async function requestDelete(ctx, { path, reason } = {}) {
  need(ctx, 'write'); path = normPath(path);
  const cur = await ctx.env.DB.prepare('SELECT rev, deleted FROM files WHERE path = ?').bind(path).first();
  if (!cur || cur.deleted) throw new WsError('not_found', `No such file: ${path}`);
  const id = await createApproval(ctx, 'delete_file', { path, rev: cur.rev }, reason);
  return { approval_id: id, status: 'pending', note: 'Nothing was deleted. The owner must approve this.' };
}
export async function requestRestore(ctx, { checkpoint_id, reason } = {}) {
  need(ctx, 'write');
  const cp = await ctx.env.DB.prepare('SELECT id, label FROM checkpoints WHERE id = ?').bind(checkpoint_id).first();
  if (!cp) throw new WsError('not_found', `No checkpoint ${checkpoint_id}`);
  const id = await createApproval(ctx, 'restore_checkpoint', { checkpoint_id: cp.id, label: cp.label }, reason);
  return { approval_id: id, status: 'pending', note: 'Nothing was restored. The owner must approve this.' };
}

export async function listApprovals(ctx, { status } = {}) {
  need(ctx, 'read');
  const q = status ? ctx.env.DB.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY id DESC LIMIT 100').bind(status) : ctx.env.DB.prepare('SELECT * FROM approvals ORDER BY id DESC LIMIT 100');
  const { results } = await q.all();
  return results.map((a) => { const p = parse(a.payload, {}); const preview = p.content !== undefined ? { ...p, content: undefined, content_preview: String(p.content).slice(0, 1500), content_length: String(p.content).length } : p; return { ...a, payload: preview, result: parse(a.result, null) }; });
}

export async function decideApproval(ctx, { id, decision, note } = {}) {
  needOwner(ctx);
  if (!['approve', 'reject'].includes(decision)) throw new WsError('bad_decision', 'decision must be approve or reject');
  const a = await ctx.env.DB.prepare('SELECT * FROM approvals WHERE id = ?').bind(id).first();
  if (!a) throw new WsError('not_found', `No approval ${id}`);
  if (a.status !== 'pending') throw new WsError('already_decided', `Approval ${id} is already ${a.status}`);
  const p = parse(a.payload, {}); let status = decision === 'approve' ? 'approved' : 'rejected'; let result = { note: note || null };
  if (decision === 'approve') {
    const ownerAuthor = { ...ctx, actor: 'owner' };
    if (a.kind === 'proposal') {
      const cur = await ctx.env.DB.prepare('SELECT * FROM files WHERE path = ?').bind(p.path).first();
      if (!cur || cur.rev !== p.base_rev) { status = 'stale'; result = { ...result, reason: `File is now at rev ${cur ? cur.rev : 'missing'}; proposal was based on rev ${p.base_rev}. Nothing was applied.` }; }
      else {
        const r = await insertRevAndUpdate(ownerAuthor, { path: p.path, base_rev: cur.rev, content: p.content, format: p.format, encoding: p.encoding, meta: cur.meta, author: a.requested_by, approved_by: 'owner', message: `Proposal #${a.id} approved`, op: 'proposal', owner: cur.owner, deleted: 0 });
        result = { ...result, applied: r };
      }
    } else if (a.kind === 'delete_file') {
      const cur = await ctx.env.DB.prepare('SELECT * FROM files WHERE path = ?').bind(p.path).first();
      if (!cur || cur.deleted || cur.rev !== p.rev) { status = 'stale'; result = { ...result, reason: 'File changed or is already gone since the request. Nothing was deleted.' }; }
      else {
        const r = await insertRevAndUpdate(ownerAuthor, { path: p.path, base_rev: cur.rev, content: cur.content, format: cur.format, encoding: cur.encoding, meta: cur.meta, author: 'owner', approved_by: 'owner', message: `Delete #${a.id} approved (content kept in history)`, op: 'delete', owner: cur.owner, deleted: 1 });
        await ctx.env.DB.prepare('DELETE FROM leases WHERE path = ?').bind(p.path).run(); result = { ...result, applied: r };
      }
    } else if (a.kind === 'restore_checkpoint') {
      result = { ...result, ...(await applyRestore(ownerAuthor, p.checkpoint_id, a.id)) };
    }
  }
  const upd = await ctx.env.DB.prepare("UPDATE approvals SET status = ?, decided_by = 'owner', decided_at = ?, result = ? WHERE id = ? AND status = 'pending'").bind(status, now(), j(result), id).run();
  if (upd.meta.changes !== 1) throw new WsError('already_decided', `Approval ${id} was decided concurrently`);
  await audit(ctx, 'approval.' + status, id, { kind: a.kind, requested_by: a.requested_by });
  await systemMessage(ctx.env, `Owner ${status} approval #${id} (${a.kind}${p.path ? ' ' + p.path : ''}).`, null, a.requested_by);
  return { id, status, result };
}

/* ---------------- checkpoints ---------------- */

export async function createCheckpoint(ctx, { label } = {}) {
  need(ctx, 'write');
  const { results } = await ctx.env.DB.prepare('SELECT path, rev FROM files WHERE deleted = 0').all();
  const manifest = Object.fromEntries(results.map((r) => [r.path, r.rev]));
  const r = await ctx.env.DB.prepare('INSERT INTO checkpoints (label, created_by, manifest, ts) VALUES (?,?,?,?)').bind(String(label || 'checkpoint').slice(0, 120), ctx.actor, j(manifest), now()).run();
  await audit(ctx, 'checkpoint.create', r.meta.last_row_id, { files: results.length });
  return { id: r.meta.last_row_id, label, files: results.length };
}
export async function listCheckpoints(ctx) {
  need(ctx, 'read');
  const { results } = await ctx.env.DB.prepare('SELECT id, label, created_by, ts, manifest FROM checkpoints ORDER BY id DESC LIMIT 50').all();
  return results.map((c) => ({ id: c.id, label: c.label, created_by: c.created_by, ts: c.ts, files: Object.keys(parse(c.manifest, {})).length }));
}
async function applyRestore(ctx, checkpointId, approvalId) {
  const cp = await ctx.env.DB.prepare('SELECT * FROM checkpoints WHERE id = ?').bind(checkpointId).first();
  if (!cp) throw new WsError('not_found', `No checkpoint ${checkpointId}`);
  const manifest = parse(cp.manifest, {}); const restored = [], skipped = [];
  for (const [path, rev] of Object.entries(manifest)) {
    const cur = await ctx.env.DB.prepare('SELECT * FROM files WHERE path = ?').bind(path).first();
    if (cur && !cur.deleted && cur.rev === rev) { skipped.push(path); continue; }
    const old = await ctx.env.DB.prepare('SELECT * FROM file_revs WHERE path = ? AND rev = ?').bind(path, rev).first();
    if (!old) continue;
    const r = await insertRevAndUpdate(ctx, { path, base_rev: cur ? cur.rev : 0, content: old.content, format: old.format, encoding: old.encoding, meta: old.meta, author: 'owner', approved_by: 'owner', message: `Restored to rev ${rev} from checkpoint ${checkpointId} (approval #${approvalId})`, op: 'restore', owner: cur ? cur.owner : 'owner', deleted: 0, created: !cur });
    restored.push({ path, from_rev: rev, new_rev: r.rev });
  }
  await ctx.env.DB.prepare('DELETE FROM leases').run();
  await audit(ctx, 'checkpoint.restore', checkpointId, { restored: restored.length });
  return { restored, unchanged: skipped, note: 'Files created after the checkpoint were left in place; restore never deletes.' };
}

/* ---------------- leases ---------------- */

export async function claimFile(ctx, { path, task_id, ttl_seconds } = {}) {
  need(ctx, 'write'); path = normPath(path);
  const cur = await ctx.env.DB.prepare('SELECT * FROM files WHERE path = ?').bind(path).first();
  if (!cur || cur.deleted) throw new WsError('not_found', `No such file: ${path}`);
  const existing = await liveLease(ctx.env, path);
  if (existing && existing.holder !== ctx.actor && !ctx.isOwner) throw new WsError('locked', `${path} is already leased by ${existing.holder}`, { holder: existing.holder, expires_at: existing.expires_at });
  let allowed = ctx.isOwner || cur.owner === ctx.actor;
  let taskRef = null;
  if (!allowed) {
    if (!Number.isInteger(task_id)) throw new WsError('not_owner', `${path} is owned by ${cur.owner}. Claiming it needs a task assigned to you that lists this path.`);
    const t = await ctx.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(task_id).first();
    if (!t) throw new WsError('not_found', `No task ${task_id}`);
    const listed = parse(t.files, []).includes(path);
    const delegated = t.created_by === 'owner' || t.created_by === cur.owner;
    if (t.assignee !== ctx.actor || !listed || !delegated || ['done', 'cancelled'].includes(t.status)) throw new WsError('not_authorised', `Task ${task_id} does not authorise ${ctx.actor} to edit ${path} (needs: assigned to you, lists the path, created by the owner or by ${cur.owner}, not finished).`);
    allowed = true; taskRef = t.id;
  }
  const ttl = Math.min(Math.max(Number(ttl_seconds) || LIMITS.leaseSeconds, 60), LIMITS.maxLeaseSeconds);
  const holder = ctx.actor === 'owner' ? (existing ? existing.holder : 'owner') : ctx.actor;
  const exp = now() + ttl * 1000;
  await ctx.env.DB.prepare('INSERT INTO leases (path, holder, task_id, acquired_at, expires_at) VALUES (?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET holder = excluded.holder, task_id = excluded.task_id, expires_at = excluded.expires_at WHERE leases.holder = excluded.holder OR leases.expires_at <= ?').bind(path, holder, taskRef ?? (Number.isInteger(task_id) ? task_id : null), now(), exp, now()).run();
  const l = await liveLease(ctx.env, path);
  if (!l || l.holder !== holder) throw new WsError('locked', `${path} was leased by someone else first`);
  await audit(ctx, 'lease.claim', path, { task_id: taskRef, ttl }); return { path, holder, expires_at: l.expires_at, task_id: l.task_id };
}
export async function releaseFile(ctx, { path } = {}) {
  need(ctx, 'write'); path = normPath(path);
  const l = await liveLease(ctx.env, path);
  if (!l) return { path, released: false, note: 'No active lease' };
  if (l.holder !== ctx.actor && !ctx.isOwner) throw new WsError('forbidden', `Lease on ${path} is held by ${l.holder}`);
  await ctx.env.DB.prepare('DELETE FROM leases WHERE path = ?').bind(path).run(); await audit(ctx, 'lease.release', path);
  return { path, released: true };
}
export async function assignOwner(ctx, { path, to } = {}) {
  needOwner(ctx); path = normPath(path); await assertKnownAgent(ctx.env, to, { allowOwner: true });
  const r = await ctx.env.DB.prepare('UPDATE files SET owner = ? WHERE path = ?').bind(to, path).run();
  if (!r.meta.changes) throw new WsError('not_found', `No such file: ${path}`);
  await ctx.env.DB.prepare('DELETE FROM leases WHERE path = ?').bind(path).run(); await audit(ctx, 'file.assign_owner', path, { to }); return { path, owner: to };
}

/* ---------------- tasks ---------------- */

const taskRow = (t) => t && ({ ...t, files: parse(t.files, []) });
export async function createTask(ctx, { title, description = '', assignee, files = [] } = {}) {
  need(ctx, 'write');
  if (!title || String(title).length > LIMITS.title) throw new WsError('bad_title', `title is required (max ${LIMITS.title} characters)`);
  const paths = [...new Set((files || []).map(normPath))];
  if (assignee) await assertKnownAgent(ctx.env, assignee);
  const ts = now();
  const r = await ctx.env.DB.prepare('INSERT INTO tasks (title, description, status, assignee, created_by, files, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(String(title), String(description).slice(0, 8000), 'open', assignee || null, ctx.actor, j(paths), ts, ts).run();
  const id = r.meta.last_row_id; await audit(ctx, 'task.create', id, { assignee, files: paths });
  if (assignee) await systemMessage(ctx.env, `${ctx.actor} created task #${id} "${title}" assigned to ${assignee}.`, id, assignee);
  return taskRow(await ctx.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first());
}
export async function listTasks(ctx, { status, assignee } = {}) {
  need(ctx, 'read');
  let sql = 'SELECT * FROM tasks WHERE 1=1'; const args = [];
  if (status) { sql += ' AND status = ?'; args.push(status); }
  if (assignee) { sql += ' AND assignee = ?'; args.push(assignee); }
  const { results } = await ctx.env.DB.prepare(sql + ' ORDER BY id DESC LIMIT 100').bind(...args).all();
  return results.map(taskRow);
}
export async function getTask(ctx, id) {
  need(ctx, 'read'); const t = await ctx.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
  if (!t) throw new WsError('not_found', `No task ${id}`); return taskRow(t);
}
export async function updateTask(ctx, { id, status, title, description, files, note } = {}) {
  need(ctx, 'write'); const t = await getTask(ctx, id);
  const involved = ctx.isOwner || t.assignee === ctx.actor || t.created_by === ctx.actor;
  if (!involved) throw new WsError('forbidden', `Task ${id} belongs to ${t.assignee || t.created_by}`);
  const sets = [], args = [];
  if (status !== undefined) { if (!TASK_STATUS.includes(status)) throw new WsError('bad_status', `status must be one of ${TASK_STATUS.join(', ')}`); sets.push('status = ?'); args.push(status); }
  if (title !== undefined) { sets.push('title = ?'); args.push(String(title).slice(0, LIMITS.title)); }
  if (description !== undefined) { sets.push('description = ?'); args.push(String(description).slice(0, 8000)); }
  if (files !== undefined) {
    if (!(ctx.isOwner || t.created_by === ctx.actor)) throw new WsError('forbidden', 'Only the task creator or the owner can change which files a task authorises');
    sets.push('files = ?'); args.push(j([...new Set(files.map(normPath))]));
  }
  if (!sets.length && !note) throw new WsError('nothing_to_do', 'Provide status, title, description, files or note');
  if (sets.length) await ctx.env.DB.prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...args, now(), id).run();
  if (status === 'done' || status === 'cancelled') await ctx.env.DB.prepare('DELETE FROM leases WHERE task_id = ?').bind(id).run();
  await audit(ctx, 'task.update', id, { status, note });
  if (note) await ctx.env.DB.prepare('INSERT INTO messages (ts, sender, recipient, kind, body, task_id) VALUES (?,?,?,?,?,?)').bind(now(), ctx.actor, 'all', 'note', String(note).slice(0, LIMITS.message), id).run();
  return getTask(ctx, id);
}
/** Sequential handoff: assignee moves to `to`, and any live leases the sender held for this task move with it. */
export async function handoffTask(ctx, { id, to, note } = {}) {
  need(ctx, 'write'); const t = await getTask(ctx, id);
  if (['done', 'cancelled'].includes(t.status)) throw new WsError('bad_status', `Task ${id} is ${t.status}`);
  const may = ctx.isOwner || t.assignee === ctx.actor || (!t.assignee && t.created_by === ctx.actor);
  if (!may) throw new WsError('forbidden', `Only the current assignee (${t.assignee || 'nobody'}) or the owner can hand off task ${id}`);
  await assertKnownAgent(ctx.env, to);
  const from = t.assignee;
  if (from === to) throw new WsError('bad_target', `Task ${id} is already assigned to ${to}`);
  const moved = [];
  if (from) {
    const { results } = await ctx.env.DB.prepare('SELECT path FROM leases WHERE holder = ? AND expires_at > ? AND (task_id = ? OR path IN (SELECT value FROM json_each(?)))').bind(from, now(), id, j(t.files)).all();
    for (const l of results) { await ctx.env.DB.prepare('UPDATE leases SET holder = ?, task_id = ?, expires_at = ? WHERE path = ?').bind(to, id, now() + LIMITS.leaseSeconds * 1000, l.path).run(); moved.push(l.path); }
  }
  await ctx.env.DB.prepare("UPDATE tasks SET assignee = ?, status = 'open', updated_at = ? WHERE id = ?").bind(to, now(), id).run();
  await ctx.env.DB.prepare('INSERT INTO messages (ts, sender, recipient, kind, body, task_id, meta) VALUES (?,?,?,?,?,?,?)').bind(now(), ctx.actor, to, 'handoff', String(note || `Handing task #${id} "${t.title}" to ${to}.`).slice(0, LIMITS.message), id, j({ from: from || null, leases_moved: moved })).run();
  await audit(ctx, 'task.handoff', id, { from, to, leases_moved: moved });
  return { task: await getTask(ctx, id), leases_moved: moved };
}

/* ---------------- messages ---------------- */

export async function postMessage(ctx, { to = 'all', body, kind = 'chat', task_id } = {}) {
  need(ctx, 'write');
  if (typeof body !== 'string' || !body.trim()) throw new WsError('bad_body', 'body is required');
  if (body.length > LIMITS.message) throw new WsError('too_large', `body exceeds ${LIMITS.message} characters`);
  if (!['chat', 'note', 'review'].includes(kind)) throw new WsError('bad_kind', 'kind must be chat, note or review (handoff and system messages are created by the server)');
  await assertKnownAgent(ctx.env, to, { allowOwner: true, allowAll: true });
  if (task_id !== undefined && task_id !== null) await getTask(ctx, task_id);
  const r = await ctx.env.DB.prepare('INSERT INTO messages (ts, sender, recipient, kind, body, task_id) VALUES (?,?,?,?,?,?)').bind(now(), ctx.actor, to, kind, body, task_id ?? null).run();
  await audit(ctx, 'message.post', r.meta.last_row_id, { to }); return { id: r.meta.last_row_id, sender: ctx.actor, to };
}
export async function getMessages(ctx, { since_id = 0, limit = 50, for_agent, task_id } = {}) {
  need(ctx, 'read');
  let sql = 'SELECT * FROM messages WHERE id > ?'; const args = [since_id];
  if (for_agent) { sql += " AND (recipient = ? OR recipient = 'all' OR sender = ?)"; args.push(for_agent, for_agent); }
  if (task_id) { sql += ' AND task_id = ?'; args.push(task_id); }
  const { results } = await ctx.env.DB.prepare(sql + ' ORDER BY id DESC LIMIT ?').bind(...args, Math.min(limit, 200)).all();
  return results.reverse().map((m) => ({ ...m, meta: parse(m.meta, {}) }));
}

/* ---------------- agents & state ---------------- */

export async function registerAgent(ctx, { id, name, kind = 'custom', description = '', scopes = ['read', 'write'], connectable = true } = {}) {
  needOwner(ctx);
  if (!AGENT_ID.test(id || '')) throw new WsError('bad_id', 'id must be 2-31 chars: lowercase letters, digits, hyphen');
  if (!AGENT_KIND_SET.has(kind)) throw new WsError('bad_kind', `kind must be one of ${AGENT_KINDS.join(', ')}`);
  if (await getAgent(ctx.env, id)) throw new WsError('exists', `Agent ${id} already exists`);
  const sc = scopes.filter((s) => ['read', 'write'].includes(s));
  await ctx.env.DB.prepare('INSERT INTO agents (id, name, kind, description, scopes, enabled, connectable, created_at) VALUES (?,?,?,?,?,1,?,?)').bind(id, String(name || id).slice(0, 80), kind, String(description).slice(0, 300), j(sc), connectable ? 1 : 0, now()).run();
  await audit(ctx, 'agent.register', id, { kind }); return getAgent(ctx.env, id);
}
export async function setAgentEnabled(ctx, { id, enabled } = {}) {
  needOwner(ctx); if (id === 'owner') throw new WsError('forbidden', 'The owner identity cannot be disabled');
  const r = await ctx.env.DB.prepare('UPDATE agents SET enabled = ? WHERE id = ?').bind(enabled ? 1 : 0, id).run();
  if (!r.meta.changes) throw new WsError('not_found', `No agent ${id}`);
  if (!enabled) await ctx.env.DB.prepare('DELETE FROM leases WHERE holder = ?').bind(id).run();
  await audit(ctx, 'agent.enable', id, { enabled: !!enabled }); return getAgent(ctx.env, id);
}

export async function workspaceState(ctx, { since_message_id = 0 } = {}) {
  need(ctx, 'read'); const db = ctx.env.DB;
  const one = async (sql, ...a) => (await db.prepare(sql).bind(...a).first()).n;
  const me = ctx.actor;
  return {
    you: { actor: ctx.actor, via: ctx.via, scopes: [...ctx.scopes] },
    agents: (await listAgents(ctx.env)).map((a) => ({ id: a.id, name: a.name, kind: a.kind, enabled: a.enabled, last_seen: a.last_seen })),
    counts: { files: await one('SELECT COUNT(*) AS n FROM files WHERE deleted = 0'), open_tasks: await one("SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN ('done','cancelled')"), pending_approvals: await one("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'"), messages: await one('SELECT COUNT(*) AS n FROM messages') },
    your_open_tasks: (await listTasks(ctx, { assignee: me })).filter((t) => !['done', 'cancelled'].includes(t.status)),
    unread_for_you: await one("SELECT COUNT(*) AS n FROM messages WHERE id > ? AND (recipient = ? OR recipient = 'all') AND sender <> ?", since_message_id, me, me),
    latest_message_id: await one('SELECT COALESCE(MAX(id),0) AS n FROM messages'),
    last_checkpoint: (await listCheckpoints(ctx))[0] || null
  };
}

export async function auditLog(ctx, { limit = 50 } = {}) {
  need(ctx, 'read'); const { results } = await ctx.env.DB.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').bind(Math.min(limit, 200)).all();
  return results.map((r) => ({ ...r, detail: parse(r.detail, {}) }));
}

export async function search(ctx, { query } = {}) {
  need(ctx, 'read'); const q = '%' + String(query || '').replace(/[%_]/g, '').slice(0, 80) + '%'; const db = ctx.env.DB; const out = [];
  for (const f of (await db.prepare("SELECT path, format, rev FROM files WHERE deleted = 0 AND (path LIKE ? OR (encoding = 'utf8' AND content LIKE ?)) LIMIT 10").bind(q, q).all()).results) out.push({ id: `file:${f.path}`, title: f.path, text: `${f.format} rev ${f.rev}` });
  for (const t of (await db.prepare('SELECT id, title, status, assignee FROM tasks WHERE title LIKE ? OR description LIKE ? LIMIT 10').bind(q, q).all()).results) out.push({ id: `task:${t.id}`, title: `Task #${t.id}: ${t.title}`, text: `${t.status}, assignee ${t.assignee || 'none'}` });
  for (const m of (await db.prepare('SELECT id, sender, body FROM messages WHERE body LIKE ? ORDER BY id DESC LIMIT 10').bind(q).all()).results) out.push({ id: `message:${m.id}`, title: `Message #${m.id} from ${m.sender}`, text: m.body.slice(0, 160) });
  return out;
}
export async function fetchById(ctx, { id } = {}) {
  need(ctx, 'read'); const [kind, ...rest] = String(id || '').split(':'); const ref = rest.join(':');
  if (kind === 'file') { const f = await readFile(ctx, { path: ref }); return { id, title: f.path, text: f.encoding === 'utf8' ? f.content : `[base64, ${f.content.length} chars]`, metadata: { rev: f.rev, format: f.format, owner: f.owner, sha: f.sha } }; }
  if (kind === 'task') { const t = await getTask(ctx, Number(ref)); return { id, title: `Task #${t.id}: ${t.title}`, text: JSON.stringify(t, null, 2), metadata: { status: t.status, assignee: t.assignee } }; }
  if (kind === 'message') { const m = await ctx.env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(Number(ref)).first(); if (!m) throw new WsError('not_found', 'No such message'); return { id, title: `Message #${m.id} from ${m.sender}`, text: m.body, metadata: { to: m.recipient, kind: m.kind } }; }
  throw new WsError('bad_id', 'id must look like file:<path>, task:<n> or message:<n>');
}

export { LIMITS };

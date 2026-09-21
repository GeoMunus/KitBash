// OAuth 2.1 authorization server for the workspace, backed by SQLite. Plugs into the MCP SDK's standard auth router
// (dynamic client registration, PKCE S256, authorization code + refresh token, discovery documents).
//
// What this file adds is the part only this project can decide: the consent screen. The owner chooses WHICH agent
// identity a connection becomes and which scopes it gets; that choice is stored with the authorization code and copied into
// the tokens. It is never taken from anything the connecting client sends, so an agent cannot pick or change who it is.
import crypto from 'node:crypto';
import { InvalidGrantError, InvalidScopeError, InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { listAgents, verifyOwnerKey, WsError } from './service.js';

const SCOPE_MAP = { 'workspace:read': 'read', 'workspace:write': 'write' };
export const SCOPES = Object.keys(SCOPE_MAP);
const ACCESS_TTL = 60 * 60 * 1000, REFRESH_TTL = 30 * 24 * 60 * 60 * 1000, CODE_TTL = 10 * 60 * 1000, PENDING_TTL = 10 * 60 * 1000, MAX_CLIENTS = 5000;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const now = () => Date.now();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const page = (res, title, body, status = 200) => {
  res.status(status).set({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" });
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;background:Canvas;color:CanvasText}
h1{font-size:22px;margin:0 0 4px}.sub{opacity:.7;margin:0 0 20px}fieldset{border:1px solid color-mix(in srgb,CanvasText 25%,transparent);border-radius:10px;margin:0 0 16px;padding:12px 14px}
legend{font-weight:600;padding:0 6px}label{display:block;margin:8px 0}input[type=password],select{width:100%;padding:10px;font:inherit;border-radius:8px;border:1px solid color-mix(in srgb,CanvasText 35%,transparent);background:Canvas;color:CanvasText;box-sizing:border-box}
button{font:inherit;font-weight:600;padding:12px 18px;border-radius:10px;border:0;background:#1f7a57;color:#fff;cursor:pointer}button.no{background:transparent;color:inherit;border:1px solid color-mix(in srgb,CanvasText 35%,transparent)}
.warn{padding:10px 12px;border-radius:8px;background:color-mix(in srgb,orange 22%,transparent);margin:0 0 16px}code{background:color-mix(in srgb,CanvasText 10%,transparent);padding:1px 5px;border-radius:4px;word-break:break-all}.err{color:#c0392b;font-weight:600}</style></head><body>${body}</body></html>`);
};
export { page as htmlPage, esc };

export function createOAuth(env) {
  const db = env.DB;

  const clientsStore = {
    async getClient(id) { const r = await db.prepare('SELECT info FROM oauth_clients WHERE client_id = ?').bind(String(id)).first(); return r ? JSON.parse(r.info) : undefined; },
    async registerClient(client) {
      const n = (await db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').first()).n;
      if (n >= MAX_CLIENTS) throw new ServerError('Too many registered clients; try again later');
      await db.prepare('INSERT INTO oauth_clients (client_id, info, created_at) VALUES (?,?,?)').bind(client.client_id, JSON.stringify(client), now()).run();
      return client;
    }
  };

  const revokeGrant = (grantId) => db.prepare('UPDATE oauth_tokens SET revoked = 1 WHERE grant_id = ?').bind(grantId).run();
  async function issue({ grantId, clientId, actor, scopes, resource }) {
    const access = 'kba_' + rand(32), refresh = 'kbr_' + rand(32), t = now();
    await db.batch([
      db.prepare('INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, actor, scopes, resource, expires_at) VALUES (?,?,?,?,?,?,?,?)').bind(sha(access), 'access', grantId, clientId, actor, JSON.stringify(scopes), resource || null, t + ACCESS_TTL),
      db.prepare('INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, actor, scopes, resource, expires_at) VALUES (?,?,?,?,?,?,?,?)').bind(sha(refresh), 'refresh', grantId, clientId, actor, JSON.stringify(scopes), resource || null, t + REFRESH_TTL)
    ]);
    return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL / 1000), refresh_token: refresh, scope: scopes.join(' ') };
  }

  const provider = {
    clientsStore,

    /** Called by the SDK's /authorize once client_id, redirect_uri and PKCE are validated. We park the request and ask the owner. */
    async authorize(client, params, res) {
      const id = rand(24);
      await db.prepare('INSERT INTO oauth_pending (id, client_id, params, expires_at) VALUES (?,?,?,?)').bind(id, client.client_id, JSON.stringify({ state: params.state, scopes: params.scopes || [], codeChallenge: params.codeChallenge, redirectUri: params.redirectUri, resource: params.resource ? params.resource.href : null }), now() + PENDING_TTL).run();
      await renderConsent(res, { id, client, params });
    },

    async challengeForAuthorizationCode(client, code) {
      const row = await db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').bind(sha(code)).first();
      if (!row || row.client_id !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
      if (row.used_at) { await revokeGrant(row.grant_id); throw new InvalidGrantError('Authorization code already used; tokens issued from it were revoked'); }
      if (row.expires_at < now()) throw new InvalidGrantError('Authorization code expired');
      return row.code_challenge;
    },

    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
      const row = await db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').bind(sha(code)).first();
      if (!row || row.client_id !== client.client_id || row.expires_at < now()) throw new InvalidGrantError('Invalid authorization code');
      if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri does not match the authorization request');
      if (resource && row.resource && resource.href !== row.resource) throw new InvalidGrantError('resource does not match the authorization request');
      const claimed = await db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL').bind(now(), sha(code)).run();
      if (claimed.meta.changes !== 1) { await revokeGrant(row.grant_id); throw new InvalidGrantError('Authorization code already used'); }
      return issue({ grantId: row.grant_id, clientId: row.client_id, actor: row.actor, scopes: JSON.parse(row.scopes), resource: row.resource });
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      const row = await db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").bind(sha(refreshToken)).first();
      if (!row || row.client_id !== client.client_id) throw new InvalidGrantError('Invalid refresh token');
      if (row.used_at || row.revoked) { await revokeGrant(row.grant_id); throw new InvalidGrantError('Refresh token already used or revoked'); }
      if (row.expires_at < now()) throw new InvalidGrantError('Refresh token expired');
      const granted = JSON.parse(row.scopes); let use = granted;
      if (scopes && scopes.length) { if (!scopes.every((s) => granted.includes(s))) throw new InvalidScopeError('Cannot widen scope on refresh'); use = scopes; }
      const claimed = await db.prepare('UPDATE oauth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').bind(now(), sha(refreshToken)).run();
      if (claimed.meta.changes !== 1) { await revokeGrant(row.grant_id); throw new InvalidGrantError('Refresh token already used'); }
      return issue({ grantId: row.grant_id, clientId: row.client_id, actor: row.actor, scopes: use, resource: row.resource });
    },

    async verifyAccessToken(token) {
      const row = await db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'").bind(sha(token)).first();
      if (!row || row.revoked) throw new InvalidTokenError('Invalid or revoked access token');
      if (row.expires_at < now()) throw new InvalidTokenError('Access token expired');
      const scopes = JSON.parse(row.scopes);
      return { token, clientId: row.client_id, scopes, expiresAt: Math.floor(row.expires_at / 1000), resource: row.resource ? new URL(row.resource) : undefined,
        extra: { actor: row.actor, scopes: scopes.map((s) => SCOPE_MAP[s]).filter(Boolean) } };
    },

    async revokeToken(client, { token }) {
      const row = await db.prepare('SELECT grant_id, client_id FROM oauth_tokens WHERE token_hash = ?').bind(sha(token)).first();
      if (row && row.client_id === client.client_id) await revokeGrant(row.grant_id);
    }
  };

  async function renderConsent(res, { id, client, params, error }) {
    const agents = (await listAgents(env)).filter((a) => a.connectable && a.enabled);
    const name = client.client_name || 'Unnamed client';
    const guess = /chatgpt|openai/i.test(name) ? 'chatgpt' : /claude|anthropic/i.test(name) ? 'claude' : '';
    const asked = params.scopes && params.scopes.length ? params.scopes.filter((s) => SCOPE_MAP[s]) : SCOPES;
    let host = ''; try { host = new URL(params.redirectUri).host || params.redirectUri; } catch { host = params.redirectUri; }
    page(res, 'Connect an agent to Kitbash Workspace', `
    <h1>Connect an agent</h1><p class="sub">Kitbash Workspace</p>
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    <div class="warn"><b>${esc(name)}</b> wants access. It will return to <code>${esc(host)}</code>. Only continue if you started this connection yourself.</div>
    <form method="post" action="/consent"><input type="hidden" name="state" value="${esc(id)}">
      <fieldset><legend>Which agent is this?</legend>
        <select name="actor" required>${agents.map((a) => `<option value="${esc(a.id)}"${a.id === guess ? ' selected' : ''}>${esc(a.name)} (${esc(a.id)})</option>`).join('')}</select>
        <p class="sub" style="margin:8px 0 0">Everything this connection does is recorded under this identity. It cannot change it later.</p></fieldset>
      <fieldset><legend>What may it do?</legend>
        <label><input type="checkbox" name="scope" value="workspace:read" checked> Read files, tasks, messages</label>
        <label><input type="checkbox" name="scope" value="workspace:write"${asked.includes('workspace:write') ? ' checked' : ''}> Write: post messages, create and hand off tasks, edit files it owns or has leased, propose changes</label>
        <p class="sub" style="margin:8px 0 0">Deleting, restoring and approving always need your owner key, whatever you choose here.</p></fieldset>
      <fieldset><legend>Owner key</legend><input type="password" name="owner_key" autocomplete="current-password" required placeholder="Your owner passphrase"></fieldset>
      <button type="submit">Approve</button> <button class="no" type="submit" name="deny" value="1" formnovalidate>Deny</button>
    </form>`);
  }

  /** POST /consent — the owner's decision. Requires the owner key; that (not a cookie) is what authorises a connection. */
  async function consent(req, res) {
    const body = req.body || {}; const id = String(body.state || '');
    const pend = await db.prepare('SELECT * FROM oauth_pending WHERE id = ?').bind(id).first();
    if (!pend || pend.expires_at < now()) return page(res, 'Cannot connect', '<h1>This request expired</h1><p>Go back to the app that started the connection and try again.</p>', 400);
    const client = await clientsStore.getClient(pend.client_id); const params = JSON.parse(pend.params);
    if (!client) return page(res, 'Cannot connect', '<h1>Unknown client</h1>', 400);
    const back = (extra) => { const u = new URL(params.redirectUri); for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v); if (params.state) u.searchParams.set('state', params.state); return u.toString(); };
    if (body.deny) { await db.prepare('DELETE FROM oauth_pending WHERE id = ?').bind(id).run(); return res.redirect(302, back({ error: 'access_denied' })); }
    const again = (msg) => renderConsent(res, { id, client, params: { scopes: params.scopes, redirectUri: params.redirectUri }, error: msg });
    try { if (!(await verifyOwnerKey(env, String(body.owner_key || '')))) return again('Wrong owner key.'); }
    catch (e) { if (e instanceof WsError) return again(e.message); throw e; }
    const actor = String(body.actor || '');
    const agent = (await listAgents(env)).find((a) => a.id === actor && a.connectable && a.enabled);
    if (!agent) return again('Choose which agent this connection is.');
    const list = [].concat(body.scope || []).map(String);
    const granted = SCOPES.filter((s) => list.includes(s) && agent.scopes.includes(SCOPE_MAP[s]));
    if (!granted.includes('workspace:read')) return again('Grant at least read access.');
    const code = rand(32);
    await db.batch([
      db.prepare('DELETE FROM oauth_pending WHERE id = ?').bind(id),
      db.prepare('INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, resource, actor, scopes, grant_id, expires_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(sha(code), client.client_id, params.redirectUri, params.codeChallenge, params.resource || null, agent.id, JSON.stringify(granted), rand(16), now() + CODE_TTL)
    ]);
    return res.redirect(302, back({ code }));
  }

  async function cleanup() {
    const t = now();
    await db.prepare('DELETE FROM oauth_pending WHERE expires_at < ?').bind(t).run();
    await db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').bind(t - 86400000).run();
    await db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').bind(t - 86400000).run();
    await db.prepare("DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM oauth_tokens)").bind(t - 30 * 86400000).run();
  }
  return { provider, consent, cleanup };
}

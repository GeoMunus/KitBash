// Kitbash Workspace server for Railway (or any Node 22+ host).
//   /              the Kitbash app (Parts, Import, Build, Team)
//   /mcp           MCP endpoint for Claude, ChatGPT and other agents (OAuth 2.1 bearer tokens)
//   /authorize /consent /token /register /.well-known/*   OAuth for those agents
//   /api/tool      the owner's own browser session (owner key in a header) — used by the Team tab when Kitbash runs from this server
//   /health        status and configuration check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { openDatabase } from './db.js';
import { createOAuth, SCOPES, htmlPage } from './oauth.js';
import { buildServer } from './mcp.js';
import { listAgents, verifyOwnerKey, WsError } from './service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;
const PORT = Number(process.env.PORT || 8787);
const ON_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);

const { DB, raw, location, applied } = openDatabase(process.env);
const env = { DB, OWNER_SECRET: process.env.OWNER_SECRET, OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_MODEL: process.env.OPENAI_MODEL, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1' };
const warnings = [];
if (!env.OWNER_SECRET || String(env.OWNER_SECRET).length < 8) warnings.push('OWNER_SECRET is not set (or shorter than 8 characters). Nothing can be approved or connected until you set it in the service Variables.');
if (ON_RAILWAY && !location.persistent) warnings.push('No Railway Volume is attached, so the database lives on the container disk and is erased on every deploy. Attach a Volume (mount path /data) to keep your workspace.');
for (const w of warnings) console.warn('[kitbash] WARNING: ' + w);
console.log(`[kitbash] database: ${location.file} (${location.source}; persistent=${location.persistent}); migrations applied now: ${applied.join(', ') || 'none'}`);

const oauth = createOAuth(env);
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);   // Railway terminates TLS in front of the app

/** The public https origin: PUBLIC_URL, else Railway's generated domain, else whatever host the request came in on. */
function originOf(req) {
  if (process.env.PUBLIC_URL) return new URL(process.env.PUBLIC_URL).origin;
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `${req.protocol}://${req.host}`;
}

// OAuth endpoints from the MCP SDK (registration, authorize, token, revoke, discovery), one router per public origin.
const routers = new Map();
function authRouterFor(origin) {
  let r = routers.get(origin);
  if (!r) {
    if (routers.size >= 8) throw new Error('too many distinct hosts');
    const rl = { rateLimit: { validate: { creationStack: false } } };   // routers are built on first sight of a host, i.e. inside a request; that is fine here
    r = mcpAuthRouter({ provider: oauth.provider, issuerUrl: new URL(origin), resourceServerUrl: new URL(origin + '/mcp'), scopesSupported: SCOPES, resourceName: 'Kitbash Workspace',
      authorizationOptions: rl, tokenOptions: rl, clientRegistrationOptions: rl, revocationOptions: rl });
    routers.set(origin, r);
  }
  return r;
}
app.use((req, res, next) => { try { return authRouterFor(originOf(req))(req, res, next); } catch (e) { return res.status(400).json({ error: 'invalid_request', error_description: 'Unrecognised host' }); } });
app.get('/.well-known/oauth-protected-resource', (req, res) => res.redirect(307, '/.well-known/oauth-protected-resource/mcp'));
app.post('/consent', express.urlencoded({ extended: false, limit: '20kb' }), (req, res, next) => oauth.consent(req, res).catch(next));

// The MCP endpoint. Stateless: every request is authenticated on its own and gets a fresh server bound to that token's identity.
const bearer = (req, res, next) => requireBearerAuth({ verifier: oauth.provider, requiredScopes: ['workspace:read'], resourceMetadataUrl: `${originOf(req)}/.well-known/oauth-protected-resource/mcp` })(req, res, next);
app.all('/mcp', bearer, (req, res, next) => {
  if (req.method === 'POST') return next();
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST.' }, id: null });
}, express.json({ limit: '2mb' }), async (req, res) => {
  const { server } = buildServer(env, req.auth.extra);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
  catch (e) { console.error('[mcp] error', e && e.stack || e); if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }); }
});

// The owner's own session (Kitbash's Team tab served from this same server). Authenticated by the owner key on every call.
app.post('/api/tool', express.json({ limit: '2mb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const key = req.get('x-owner-key') || '';
  const reject = (status, error, message) => res.status(status).json({ isError: true, text: JSON.stringify({ error, message }) });
  if (!key) return reject(401, 'owner_required', 'Send your owner key in the x-owner-key header');
  try { if (!(await verifyOwnerKey(env, key))) return reject(401, 'bad_owner_key', 'Owner key rejected'); }
  catch (e) { if (e instanceof WsError) return reject(e.code === 'locked_out' ? 429 : 503, e.code, e.message); throw e; }
  const { tool, input } = req.body || {};
  if (typeof tool !== 'string') return reject(400, 'bad_request', 'tool must be a string');
  const { invoke } = buildServer(env, { owner_session: true, scopes: ['read', 'write'] });
  const r = await invoke(tool, input && typeof input === 'object' ? input : {});
  res.json({ isError: !!r.isError, text: r.content[0].text });
});

app.get('/health', async (req, res) => {
  const agents = (await listAgents(env)).map((a) => a.id);
  res.set('Cache-Control', 'no-store').json({
    ok: true, service: 'kitbash-workspace', version: VERSION, mcp: `${originOf(req)}/mcp`, agents,
    owner_secret_configured: !!env.OWNER_SECRET && String(env.OWNER_SECRET).length >= 8, openai_configured: !!env.OPENAI_API_KEY && !!env.OPENAI_MODEL,
    database: { persistent: location.persistent, source: location.source, file: location.file }, warnings
  });
});

// The Kitbash app itself. kitbash.html is the same single-file build that is published as a Claude artifact; here it is wrapped in a page
// and told it is being served by its own workspace server, so the Team tab talks to /api/tool instead of a claude.ai connector.
const appHtml = (() => {
  const f = path.join(HERE, 'kitbash.html');
  if (!fs.existsSync(f)) return null;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="kitbash-server" content="same-origin"></head><body>${fs.readFileSync(f, 'utf8')}</body></html>`;
})();
const serveApp = (req, res) => appHtml ? res.set({ 'Cache-Control': 'no-cache', 'X-Frame-Options': 'SAMEORIGIN' }).type('html').send(appHtml) : htmlPage(res, 'Kitbash Workspace', '<h1>Kitbash Workspace</h1><p>The server is running. kitbash.html was not found next to server.js.</p>');
app.get(['/', '/app'], serveApp);
app.use((req, res) => res.status(404).json({ error: 'not_found' }));
app.use((err, req, res, next) => { console.error('[server] error', err && err.stack || err); if (res.headersSent) return next(err); res.status(err && err.status && err.status < 500 ? err.status : 500).json({ error: 'server_error' }); });

const server = app.listen(PORT, '0.0.0.0', () => console.log(`[kitbash] listening on :${PORT}${process.env.RAILWAY_PUBLIC_DOMAIN ? ` — https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ''}`));
const sweep = setInterval(() => oauth.cleanup().catch((e) => console.error('[cleanup]', e.message)), 60 * 60 * 1000); sweep.unref();
function shutdown(sig) {
  console.log(`[kitbash] ${sig}: shutting down`);
  server.close(() => { try { raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); raw.close(); } catch { /* already closed */ } process.exit(0); });
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));

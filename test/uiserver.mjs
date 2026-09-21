// Helper for the Team-tab UI test: mints a real OAuth token for the "claude" identity (same flow ChatGPT/Claude use)
// and runs a mock OpenAI server on :8899 so the embedded agent can be exercised without a real API key.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OWNER = process.env.OWNER_KEY || 'test-owner-secret-123';
const REDIRECT = 'http://localhost:9999/cb';
const asm = await (await fetch(BASE + '/.well-known/oauth-authorization-server')).json();
const EP = (u) => BASE + new URL(u).pathname;
const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function token(clientName, actor, scopes) {
  const reg = await (await fetch(EP(asm.registration_endpoint), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) })).json();
  const verifier = b64u(crypto.randomBytes(32)); const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's', scope: 'workspace:read workspace:write', resource: BASE + '/mcp' });
  const authUrl = EP(asm.authorization_endpoint) + '?' + q; const html = await (await fetch(authUrl)).text(); const sealed = /name="state" value="([^"]+)"/.exec(html)[1];
  const action = /<form[^>]*action="([^"]+)"/.exec(html)?.[1]; const postUrl = action ? BASE + new URL(action, BASE).pathname : authUrl;
  const f = new URLSearchParams(); f.set('state', sealed); f.set('actor', actor); for (const s of scopes) f.append('scope', s); f.set('owner_key', OWNER);
  const r = await fetch(postUrl, { method: 'POST', body: f, redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const code = new URL(r.headers.get('location')).searchParams.get('code');
  const t = await (await fetch(EP(asm.token_endpoint), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: BASE + '/mcp' }) })).json();
  return t.access_token;
}
const out = { claude: await token('Claude (ui test)', 'claude', ['workspace:read', 'workspace:write']), chatgpt_ro: await token('ChatGPT (ui test, read-only)', 'chatgpt', ['workspace:read']) };
fs.writeFileSync('/tmp/ui-tokens.json', JSON.stringify(out));
const seen = [];
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    const parsed = JSON.parse(body || '{}'); const input = JSON.parse(parsed.messages[1].content); seen.push(input);
    const files = Object.entries(input.task_files || {});
    let o;
    if (input.task && files.length) { const [p, f] = files[0]; o = { messages: [{ to: 'claude', body: `Edited ${p}. Please review.` }], writes: [{ path: p, content: f.content + '\n- edited by openai-api', base_rev: f.rev }], task: { status: 'review', note: 'done' }, handoff: { to: 'claude', note: `Edited ${p}; needs a review.` } }; }
    else o = { messages: [{ to: 'owner', body: 'Hello from the embedded OpenAI agent. I only know what is in this workspace.' }] };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(o) } }], usage: { total_tokens: 7 } }));
  });
}).listen(8899, '127.0.0.1', () => console.log('ready'));

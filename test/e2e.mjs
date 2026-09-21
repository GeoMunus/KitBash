// End-to-end test against a running Kitbash Workspace server (local `npm start`, or your deployed Railway URL).
//   BASE=http://127.0.0.1:8787 OWNER_KEY=... node test/e2e.mjs            (phase 1: full scenario)
//   node test/e2e.mjs --phase=verify                                      (phase 2: after a restart, old tokens + data still work)
// Uses a real OAuth flow (dynamic client registration, PKCE S256, consent form) and the official MCP SDK client.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OWNER = process.env.OWNER_KEY || 'test-owner-secret-123';
const PHASE = (process.argv.find((a) => a.startsWith('--phase=')) || '--phase=main').split('=')[1];
const STATE = '/tmp/kitbash-e2e-state.json';
const REDIRECT = 'http://localhost:9999/cb';
// Endpoints come from the discovery document, like a real client. (Works for the Node/Railway server and the older Worker.)
const asm0 = await (await fetch(BASE + '/.well-known/oauth-authorization-server')).json();
const EP = { register: BASE + new URL(asm0.registration_endpoint).pathname, token: BASE + new URL(asm0.token_endpoint).pathname, authorize: BASE + new URL(asm0.authorization_endpoint).pathname };
let pass = 0, fail = 0; const failures = [];
const check = (name, cond, extra) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; failures.push(name); console.log('  FAIL', name, extra !== undefined ? '\n       ' + JSON.stringify(extra).slice(0, 400) : ''); } };
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function oauthConnect(clientName, actor, scopes) {
  const reg = await (await fetch(EP.register, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) })).json();
  const verifier = b64u(crypto.randomBytes(32)); const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-' + clientName, scope: 'workspace:read workspace:write', resource: BASE + '/mcp' });
  const authUrl = EP.authorize + '?' + q;
  const html = await (await fetch(authUrl)).text();
  const sealed = /name="state" value="([^"]+)"/.exec(html)?.[1];
  const action = /<form[^>]*action="([^"]+)"/.exec(html)?.[1]; const postUrl = action ? BASE + new URL(action, BASE).pathname : authUrl;   // the consent form posts to /consent (Node) or back to /authorize (Worker)
  const post = (owner_key, extra = {}) => { const f = new URLSearchParams(); f.set('state', sealed); f.set('actor', actor); for (const s of scopes) f.append('scope', s); f.set('owner_key', owner_key); for (const [k, v] of Object.entries(extra)) f.set(k, v); return fetch(postUrl, { method: 'POST', body: f, redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } }); };
  return { reg, verifier, sealed, html, post, async finish() {
    const r = await post(OWNER); const loc = r.headers.get('location'); if (!loc) throw new Error('no redirect: ' + r.status);
    const code = new URL(loc).searchParams.get('code');
    const tok = await fetch(EP.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: BASE + '/mcp' }) });
    return { status: tok.status, json: await tok.json(), code };
  } };
}

async function mcpClient(token) {
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
  const call = async (name, args = {}) => {
    try { const r = await client.callTool({ name, arguments: args }); const t = r.content?.[0]?.text; let d = t; try { d = JSON.parse(t); } catch { /* text */ } return { err: !!r.isError, d }; }
    catch (e) { return { err: true, d: { error: 'protocol', message: String(e.message || e) } }; }
  };
  return { client, call };
}

/* ---- mock OpenAI ---- */
function startMockOpenAI(port) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      const parsed = JSON.parse(body || '{}'); seen.push({ auth: req.headers.authorization, url: req.url, body: parsed });
      const input = JSON.parse(parsed.messages[1].content);
      const tf = input.task_files || {}; const out = { messages: [{ to: 'claude', body: 'Plan updated, please review.' }], task: { status: 'review', note: 'implemented' }, handoff: { to: 'claude', note: 'Edited work/plan.md and added ai/new.md; check the ntree pack untouched.' }, writes: [] };
      if (tf['work/plan.md']) out.writes.push({ path: 'work/plan.md', content: tf['work/plan.md'].content + '\n- edited by openai-api', base_rev: tf['work/plan.md'].rev, message: 'append line' });
      out.writes.push({ path: 'ntree/pack.ntree', content: 'HACKED', base_rev: 1, message: 'should be rejected' });
      out.writes.push({ path: 'ai/new.md', content: 'hello from the embedded agent', base_rev: 0 });
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: { total_tokens: 42 } }));
    });
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({ srv, seen })));
}

async function main() {
  if (PHASE === 'verify') return verify();
  console.log('== discovery & unauthenticated access');
  const unauth = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('unauthenticated /mcp is 401 with resource_metadata challenge', unauth.status === 401 && /resource_metadata=/.test(unauth.headers.get('www-authenticate') || ''), unauth.headers.get('www-authenticate'));
  const garbage = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-token' }, body: '{}' });
  check('garbage bearer token is 401', garbage.status === 401);
  const prm = await (await fetch(BASE + '/.well-known/oauth-protected-resource/mcp')).json();
  const asm = await (await fetch(BASE + '/.well-known/oauth-authorization-server')).json();
  check('protected-resource metadata published', !!prm.authorization_servers, prm);
  check('AS metadata: S256 PKCE + dynamic registration', (asm.code_challenge_methods_supported || []).includes('S256') && !!asm.registration_endpoint, asm);

  console.log('== consent screen & OAuth');
  const c1 = await oauthConnect('Claude connector', 'claude', ['workspace:read', 'workspace:write']);
  check('consent page names the client and shows its redirect host', c1.html.includes('Claude connector') && c1.html.includes('localhost:9999'));
  const bad = await c1.post('wrong-key'); const badHtml = await bad.text();
  check('wrong owner key does not authorise (no redirect, error shown)', bad.status === 200 && !bad.headers.get('location') && /Wrong owner key/.test(badHtml));
  const badActor = await c1.post(OWNER, { actor: 'owner' });
  check('cannot bind a connection to the owner identity', !badActor.headers.get('location'), badActor.status);
  const badActor2 = await c1.post(OWNER, { actor: 'openai-api' });
  check('cannot bind a connection to the server-side embedded agent', !badActor2.headers.get('location'), badActor2.status);
  const t1 = await c1.finish();
  check('token exchange with PKCE succeeds', t1.status === 200 && !!t1.json.access_token, t1.json);
  const cRe = await oauthConnect('Replay test', 'claude', ['workspace:read']); const tRe = await cRe.finish();
  const replay = await fetch(EP.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: tRe.code, redirect_uri: REDIRECT, client_id: cRe.reg.client_id, code_verifier: cRe.verifier, resource: BASE + '/mcp' }) });
  check('authorization code cannot be replayed', replay.status >= 400);
  const afterReplay = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + tRe.json.access_token }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  check('replaying a code revokes the token it produced (OAuth 2.1)', afterReplay.status === 401, afterReplay.status);
  const cBadPkce = await oauthConnect('Bad PKCE', 'claude', ['workspace:read']); const r = await cBadPkce.post(OWNER); const code = new URL(r.headers.get('location')).searchParams.get('code');
  const badTok = await fetch(EP.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: cBadPkce.reg.client_id, code_verifier: 'x'.repeat(50), resource: BASE + '/mcp' }) });
  check('wrong PKCE verifier is rejected', badTok.status >= 400);

  const c2 = await oauthConnect('ChatGPT connector', 'chatgpt', ['workspace:read', 'workspace:write']); const t2 = await c2.finish();
  const c3 = await oauthConnect('ChatGPT read-only', 'chatgpt', ['workspace:read']); const t3 = await c3.finish();
  const claude = await mcpClient(t1.json.access_token); const gpt = await mcpClient(t2.json.access_token); const gptRO = await mcpClient(t3.json.access_token);
  fs.writeFileSync(STATE, JSON.stringify({ tokens: { claude: t1.json.access_token, gpt: t2.json.access_token, gptRO: t3.json.access_token } }));

  console.log('== identity & scopes');
  const me1 = await claude.call('whoami'), me2 = await gpt.call('whoami'), me3 = await gptRO.call('whoami');
  check('claude token → actor claude', me1.d.you?.actor === 'claude', me1.d);
  check('chatgpt token → actor chatgpt', me2.d.you?.actor === 'chatgpt');
  check('read-only token → scopes [read] only', JSON.stringify(me3.d.you?.scopes) === '["read"]', me3.d.you);
  const roTools = (await gptRO.client.listTools()).tools.map((t) => t.name); const rwTools = (await gpt.client.listTools()).tools.map((t) => t.name);
  check('read-only connection is not offered write tools', !roTools.includes('write_file') && !roTools.includes('decide_approval') && roTools.includes('read_file') && roTools.includes('search') && roTools.includes('fetch'), roTools);
  check('read-write connection is offered write tools', rwTools.includes('write_file') && rwTools.includes('handoff_task') && rwTools.includes('propose_change'));
  const roWrite = await gptRO.call('write_file', { path: 'x.md', content: 'x', base_rev: 0 });
  check('read-only connection cannot call write_file', roWrite.err, roWrite.d);
  const spoof = await claude.call('post_message', { to: 'all', body: 'spoof attempt', sender: 'owner', actor: 'chatgpt' });
  const msgs = (await claude.call('get_messages', { limit: 5 })).d;
  check('sender/actor arguments are ignored; sender is the token identity', msgs.at(-1).body === 'spoof attempt' && msgs.at(-1).sender === 'claude', msgs.at(-1));
  const kindSpoof = await claude.call('post_message', { body: 'fake handoff', kind: 'handoff' });
  check('agents cannot forge handoff/system messages', kindSpoof.err, kindSpoof.d);

  console.log('== revisions, ownership, conflicts');
  const w1 = await claude.call('write_file', { path: 'docs/a.md', content: 'v1', base_rev: 0, message: 'create' });
  check('create file at rev 1, owner claude', w1.d.rev === 1 && w1.d.owner === 'claude', w1.d);
  const wg = await gpt.call('write_file', { path: 'docs/a.md', content: 'gpt overwrite', base_rev: 1 });
  check("chatgpt cannot overwrite claude's file (not_owner)", wg.err && wg.d.error === 'not_owner', wg.d);
  const wg0 = await gpt.call('write_file', { path: 'docs/a.md', content: 'gpt create', base_rev: 0 });
  check('creating over an existing path is a conflict', wg0.err && wg0.d.error === 'conflict', wg0.d);
  const w2 = await claude.call('write_file', { path: 'docs/a.md', content: 'v2', base_rev: 1 });
  check('update with correct base_rev → rev 2', w2.d.rev === 2);
  const wStale = await claude.call('write_file', { path: 'docs/a.md', content: 'lost update', base_rev: 1 });
  const cur = await claude.call('read_file', { path: 'docs/a.md' });
  check('stale base_rev → conflict and nothing overwritten', wStale.err && wStale.d.error === 'conflict' && wStale.d.current_rev === 2 && cur.d.content === 'v2', wStale.d);
  const old = await gpt.call('read_file', { path: 'docs/a.md', rev: 1 });
  check('older revision readable by another agent', old.d.content === 'v1' && old.d.rev === 1);
  const hist = await gpt.call('file_history', { path: 'docs/a.md' });
  check('history records authors per revision', hist.d.length === 2 && hist.d[0].author === 'claude' && hist.d[1].message === 'create', hist.d);
  const badPath = await claude.call('write_file', { path: '../etc/passwd', content: 'x', base_rev: 0 });
  check('path traversal rejected', badPath.err && badPath.d.error === 'bad_path');

  console.log('== NTree / NTN resources are preserved as opaque content');
  const ntree = '{"schema":"ntree/0","name":"Zoë – 測試","skills":["a","b"]}\r\n\t  trailing  \r\n';
  const w3 = await claude.call('write_file', { path: 'ntree/pack.ntree', content: ntree, base_rev: 0, format: 'ntree/manifest', meta: { source: 'phone/termux', original_name: 'pack.ntree' } });
  const rd = await gpt.call('read_file', { path: 'ntree/pack.ntree' });
  check('NTree manifest round-trips byte-for-byte with format tag and metadata', rd.d.content === ntree && rd.d.format === 'ntree/manifest' && rd.d.sha === sha(ntree) && rd.d.meta.original_name === 'pack.ntree', rd.d);
  const bin = Buffer.from([0, 1, 2, 250, 251, 252, 13, 10]).toString('base64');
  await claude.call('write_file', { path: 'ntn/blob.bin', content: bin, base_rev: 0, format: 'ntn/asset', encoding: 'base64' });
  const rb = await gpt.call('read_file', { path: 'ntn/blob.bin' });
  check('binary NTN asset stored as base64 and returned unchanged', rb.d.content === bin && rb.d.encoding === 'base64');
  check('binary asset fingerprint and size describe the original bytes', rb.d.sha === crypto.createHash('sha256').update(Buffer.from(bin, 'base64')).digest('hex') && (await claude.call('list_files', { prefix: 'ntn/blob' })).d[0].size === 8, rb.d.sha);

  console.log('== approvals for changes and destructive operations');
  const prop = await gpt.call('propose_change', { path: 'docs/a.md', content: 'v-gpt', base_rev: 2, rationale: 'clearer wording' });
  const afterProp = await claude.call('read_file', { path: 'docs/a.md' });
  check('proposal is pending and changes nothing', prop.d.status === 'pending' && afterProp.d.content === 'v2' && afterProp.d.rev === 2, prop.d);
  const noKey = await gpt.call('decide_approval', { id: prop.d.approval_id, decision: 'approve' });
  check('agents cannot approve (owner key required)', noKey.err, noKey.d);
  const wrongKey = await gpt.call('decide_approval', { id: prop.d.approval_id, decision: 'approve', owner_key: 'guess-1' });
  check('wrong owner key rejected', wrongKey.err && wrongKey.d.error === 'bad_owner_key', wrongKey.d);
  await claude.call('write_file', { path: 'docs/a.md', content: 'v3', base_rev: 2 });
  const stale = await claude.call('decide_approval', { id: prop.d.approval_id, decision: 'approve', owner_key: OWNER });
  const afterStale = await claude.call('read_file', { path: 'docs/a.md' });
  check('approving a stale proposal applies nothing (status stale)', stale.d.status === 'stale' && afterStale.d.content === 'v3', stale.d);
  const prop2 = await gpt.call('propose_change', { path: 'docs/a.md', content: 'v4-by-gpt', base_rev: 3 });
  const ok2 = await claude.call('decide_approval', { id: prop2.d.approval_id, decision: 'approve', owner_key: OWNER });
  const h2 = await claude.call('file_history', { path: 'docs/a.md', limit: 1 });
  check('approved proposal becomes a new revision authored by chatgpt, approved_by owner', ok2.d.status === 'approved' && h2.d[0].author === 'chatgpt' && h2.d[0].approved_by === 'owner' && h2.d[0].rev === 4, h2.d);
  const cp = await claude.call('create_checkpoint', { label: 'before cleanup' });
  const del = await gpt.call('request_delete', { path: 'docs/a.md', reason: 'obsolete' });
  const stillThere = await claude.call('read_file', { path: 'docs/a.md' });
  check('delete request leaves the file intact', del.d.status === 'pending' && !stillThere.d.deleted);
  const denyDel = await claude.call('decide_approval', { id: del.d.approval_id, decision: 'approve', owner_key: OWNER });
  const gone = await claude.call('read_file', { path: 'docs/a.md' }); const listed = (await claude.call('list_files')).d.map((f) => f.path);
  check('approved delete tombstones the file and hides it from listings', denyDel.d.status === 'approved' && gone.d.deleted === true && !listed.includes('docs/a.md'), denyDel.d);
  const lastGood = await claude.call('read_file', { path: 'docs/a.md', rev: 4 });
  check('deleted content is still in history', lastGood.d.content === 'v4-by-gpt');
  const rest = await gpt.call('request_restore', { checkpoint_id: cp.d.id, reason: 'need it back' });
  const restOk = await claude.call('decide_approval', { id: rest.d.approval_id, decision: 'approve', owner_key: OWNER });
  const back = await claude.call('read_file', { path: 'docs/a.md' });
  check('restore-from-checkpoint (approved) brings the file back as a new revision', restOk.d.status === 'approved' && back.d.deleted === false && back.d.content === 'v4-by-gpt' && back.d.rev === 6, back.d);
  const rejectable = await gpt.call('request_delete', { path: 'ntn/blob.bin' }); const rej = await claude.call('decide_approval', { id: rejectable.d.approval_id, decision: 'reject', owner_key: OWNER });
  check('rejected request changes nothing', rej.d.status === 'rejected' && !(await claude.call('read_file', { path: 'ntn/blob.bin' })).d.deleted);

  console.log('== sequential task handoff with leases');
  await claude.call('write_file', { path: 'work/plan.md', content: '# Plan\n- step 1 (claude)', base_rev: 0 });
  const task = await claude.call('create_task', { title: 'Draft the plan', description: 'Two agents, one after the other', assignee: 'claude', files: ['work/plan.md'] });
  const tid = task.d.id;
  const cl1 = await claude.call('claim_file', { path: 'work/plan.md', task_id: tid });
  check('assignee claims a lease', cl1.d.holder === 'claude', cl1.d);
  const gClaim = await gpt.call('claim_file', { path: 'work/plan.md', task_id: tid });
  check('other agent cannot claim a leased file', gClaim.err && gClaim.d.error === 'locked', gClaim.d);
  const gWrite = await gpt.call('write_file', { path: 'work/plan.md', content: 'sneaky', base_rev: 1 });
  check('other agent cannot write while leased', gWrite.err && ['locked', 'not_owner'].includes(gWrite.d.error), gWrite.d);
  const notAssignee = await gpt.call('handoff_task', { id: tid, to: 'chatgpt' });
  check('only the assignee (or owner) can hand a task off', notAssignee.err && notAssignee.d.error === 'forbidden', notAssignee.d);
  await claude.call('write_file', { path: 'work/plan.md', content: '# Plan\n- step 1 (claude)\n- step 2 (claude)', base_rev: 1 });
  const ho = await claude.call('handoff_task', { id: tid, to: 'chatgpt', note: 'Steps 1-2 done. Please add step 3 and review.' });
  check('handoff moves assignee and reports leases moved', ho.d.task.assignee === 'chatgpt' && ho.d.leases_moved.includes('work/plan.md'), ho.d);
  const cwAfter = await claude.call('write_file', { path: 'work/plan.md', content: 'claude keeps editing', base_rev: 2 });
  check('sender can no longer write after handoff', cwAfter.err && cwAfter.d.error === 'locked', cwAfter.d);
  const gw = await gpt.call('write_file', { path: 'work/plan.md', content: '# Plan\n- step 1 (claude)\n- step 2 (claude)\n- step 3 (chatgpt)', base_rev: 2, message: 'step 3' });
  check('receiver can write (rev 3, author chatgpt, owner still claude)', gw.d.rev === 3 && gw.d.owner === 'claude', gw.d);
  const hmsgs = (await gpt.call('get_messages', { task_id: tid })).d.filter((m) => m.kind === 'handoff');
  check('handoff is visible in the shared log with sender and note', hmsgs.length === 1 && hmsgs[0].sender === 'claude' && hmsgs[0].recipient === 'chatgpt' && /step 3/.test(hmsgs[0].body), hmsgs);
  await gpt.call('update_task', { id: tid, status: 'done', note: 'finished' });
  const afterDone = await gpt.call('write_file', { path: 'work/plan.md', content: 'after done', base_rev: 3 });
  check('finishing a task releases the lease (edit rights end)', afterDone.err && afterDone.d.error === 'not_owner', afterDone.d);
  const selfTask = await gpt.call('create_task', { title: 'Self-authorised grab', assignee: 'chatgpt', files: ['work/plan.md'] });
  const grab = await gpt.call('claim_file', { path: 'work/plan.md', task_id: selfTask.d.id });
  check("an agent cannot authorise itself onto another agent's file via its own task", grab.err && grab.d.error === 'not_authorised', grab.d);
  const ownerTask = await claude.call('create_task', { title: 'Owner-delegated edit', assignee: 'chatgpt', files: ['work/plan.md'], owner_key: OWNER });
  const grab2 = await gpt.call('claim_file', { path: 'work/plan.md', task_id: ownerTask.d.id });
  check('a task created by the owner does authorise its assignee', !grab2.err && grab2.d.holder === 'chatgpt' && ownerTask.d.created_by === 'owner', [ownerTask.d, grab2.d]);
  await claude.call('update_task', { id: ownerTask.d.id, status: 'cancelled', owner_key: OWNER });

  console.log('== agent registry');
  const agents = (await claude.call('list_agents')).d.map((a) => a.id);
  check('registry lists claude, chatgpt, openai-api, owner', ['claude', 'chatgpt', 'openai-api', 'owner'].every((x) => agents.includes(x)), agents);
  const reg = await claude.call('register_agent', { id: 'gemini-helper', name: 'Future agent', kind: 'custom', owner_key: OWNER });
  check('owner can register a future agent', !reg.err && reg.d.id === 'gemini-helper', reg.d);
  const regNoKey = await claude.call('register_agent', { id: 'sneaky', kind: 'custom' });
  check('agents cannot register agents without the owner key', regNoKey.err);
  await claude.call('set_agent_enabled', { id: 'chatgpt', enabled: false, owner_key: OWNER });
  const disabled = await gpt.call('whoami');
  check('disabling an agent blocks its existing token', disabled.err && disabled.d.error === 'agent_disabled', disabled.d);
  await claude.call('set_agent_enabled', { id: 'chatgpt', enabled: true, owner_key: OWNER });
  check('re-enabled agent works again', !(await gpt.call('whoami')).err);

  console.log('== embedded OpenAI agent (mock OpenAI API)');
  const { srv, seen } = await startMockOpenAI(8899);
  const t4 = await claude.call('create_task', { title: 'Extend the plan', assignee: 'openai-api', files: ['work/plan.md'], owner_key: OWNER });
  const planBefore = (await claude.call('read_file', { path: 'work/plan.md' })).d;
  const noKeyRun = await claude.call('run_agent', { task_id: t4.d.id });
  check('run_agent requires the owner key', noKeyRun.err);
  const run = await claude.call('run_agent', { task_id: t4.d.id, owner_key: OWNER });
  check('run_agent completes', !run.err, run.d);
  const planAfter = (await claude.call('read_file', { path: 'work/plan.md' })).d; const hp = (await claude.call('file_history', { path: 'work/plan.md', limit: 1 })).d[0];
  check('embedded agent edited the file it was authorised for, as openai-api', /edited by openai-api/.test(planAfter.content) && hp.author === 'openai-api' && planAfter.rev === planBefore.rev + 1, hp);
  const packAfter = (await claude.call('read_file', { path: 'ntree/pack.ntree' })).d;
  check("embedded agent's write to another agent's file was rejected and nothing changed", packAfter.content === ntree && run.d.rejected.some((r) => r.label.includes('ntree/pack.ntree') && r.error === 'not_owner'), run.d.rejected);
  const created = (await claude.call('read_file', { path: 'ai/new.md' })).d;
  check('embedded agent can create its own file and owns it', created.owner === 'openai-api');
  const t4after = (await claude.call('get_task', { id: t4.d.id })).d;
  const logs = (await claude.call('get_messages', { task_id: t4.d.id })).d;
  check('embedded agent handed the task to claude, visible in the log', t4after.assignee === 'claude' && logs.some((m) => m.kind === 'handoff' && m.sender === 'openai-api' && m.recipient === 'claude'), logs);
  const req = seen[0];
  check('OpenAI API called with the server-side key, not a caller-supplied one', req.auth === 'Bearer sk-test-mock-key' && req.url.endsWith('/chat/completions'));
  check('embedded agent is told it is not the ChatGPT app and has no ChatGPT memory', /NOT the ChatGPT app/.test(req.body.messages[0].content) && /do NOT remember/.test(req.body.messages[0].content));
  check('context sent to the model is workspace state (task files, messages), not conversation memory', !!JSON.parse(req.body.messages[1].content).task_files['work/plan.md']);
  const notMine = await claude.call('run_agent', { task_id: tid, owner_key: OWNER });
  check('run_agent refuses tasks not assigned to the embedded agent', notMine.err);
  srv.close();

  console.log('== audit trail');
  const aud = (await claude.call('audit_log', { limit: 200 })).d;
  check('audit log records identities incl. owner-key actions via a connection', aud.some((a) => a.actor === 'owner' && a.via === 'claude') && aud.some((a) => a.actor === 'chatgpt') && aud.some((a) => a.actor === 'openai-api'));

  console.log('== read-only search/fetch (works for read-only ChatGPT plans)');
  const s = await gptRO.call('search', { query: 'plan' }); const f = await gptRO.call('fetch', { id: 'file:work/plan.md' });
  check('search finds the file; fetch returns its text', s.d.some((x) => x.id === 'file:work/plan.md') && /step 3/.test(f.d.text), [s.d, f.d]);

  console.log('== owner-key brute force lockout');
  let locked = false; for (let i = 0; i < 15 && !locked; i++) { const r2 = await claude.call('decide_approval', { id: 1, decision: 'approve', owner_key: 'bad-' + i }); locked = r2.d.error === 'locked_out'; }
  check('repeated wrong owner keys lock owner actions out', locked);
  const lockedCorrect = await claude.call('decide_approval', { id: 1, decision: 'approve', owner_key: OWNER });
  check('lockout also blocks the correct key until it expires', lockedCorrect.d.error === 'locked_out', lockedCorrect.d);

  // snapshot for persistence check
  const snapFiles = (await claude.call('list_files', { include_deleted: true })).d.map((x) => [x.path, x.rev, x.sha, x.owner]);
  const snapMsgs = (await claude.call('get_messages', { limit: 200 })).d.length; const snapTasks = (await claude.call('list_tasks')).d.length;
  fs.writeFileSync(STATE, JSON.stringify({ ...JSON.parse(fs.readFileSync(STATE, 'utf8')), snapFiles, snapMsgs, snapTasks }));
  finish();
}

async function verify() {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  console.log('== after restart: same tokens, same data');
  const claude = await mcpClient(st.tokens.claude); const gpt = await mcpClient(st.tokens.gpt);
  const who = await gpt.call('whoami'); check('OAuth token issued before the restart still authenticates (persisted)', who.d.you?.actor === 'chatgpt', who.d);
  const files = (await gpt.call('list_files', { include_deleted: true })).d.map((x) => [x.path, x.rev, x.sha, x.owner]);
  check('every file, revision number, hash and owner survived', JSON.stringify(files) === JSON.stringify(st.snapFiles), { before: st.snapFiles.length, after: files.length });
  const old = await gpt.call('read_file', { path: 'work/plan.md', rev: 1 }); check('old revisions survived', old.d.content === '# Plan\n- step 1 (claude)');
  check('messages and tasks survived', (await gpt.call('get_messages', { limit: 200 })).d.length === st.snapMsgs && (await gpt.call('list_tasks')).d.length === st.snapTasks);
  finish();
}
function finish() { console.log(`\n${pass} passed, ${fail} failed`); if (fail) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exit(1); } process.exit(0); }
main().catch((e) => { console.error('test crashed:', e); process.exit(2); });

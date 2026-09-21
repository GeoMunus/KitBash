/* ================= TEAM — shared multi-agent workspace =================
   Talks to the Kitbash Workspace server. Inside claude.ai that is the custom connector, reached through the page's `mcp` capability;
   when Kitbash is served by the workspace server itself (standalone) it is the same server, reached at /api/tool with the owner key.
   Identity rules live on the server: this page's connection is whichever agent the owner picked when adding
   the connector (normally "claude"). Owner-authority actions (approve, write as owner, run the OpenAI agent)
   add the owner key to the call; agent-authority actions (what in-page Claude does) never carry it. */
const TEAM_SERVER = 'Kitbash Workspace';
const TEAM_TOOLS = ['whoami', 'list_agents', 'list_files', 'read_file', 'list_tasks', 'get_messages', 'list_approvals', 'list_checkpoints',
  'post_message', 'create_task', 'update_task', 'handoff_task', 'claim_file', 'write_file', 'propose_change', 'create_checkpoint',
  'decide_approval', 'register_agent', 'set_agent_enabled', 'run_agent'];
const team = { status: 'idle', err: '', me: null, agents: [], files: [], tasks: [], messages: [], approvals: [], checkpoints: [], sub: 'chat', to: 'claude', busy: '', key: '', openFile: null, draft: '', form: {} };
try { team.key = sessionStorage.getItem('kb-owner-key') || ''; } catch { /* storage unavailable */ }
const TEAM_SUBS = [['chat', 'Chat'], ['tasks', 'Tasks'], ['files', 'Files'], ['approvals', 'Approvals'], ['agents', 'Agents']];
const TO_OPTS = [['claude', 'Claude'], ['openai-api', 'OpenAI agent'], ['both', 'Both, Claude first'], ['chatgpt', 'ChatGPT (inbox only)']];
/* Standalone mode: this page was served by the workspace server, so talk to it directly. Every call carries the owner key, and the
   server treats the caller as the owner (never as an agent). Same tool names and results as the connector. */
function teamServerMcp() {
  return { callTool: async (_server, tool, input) => {
    if (!team.key) throw { code: 'need_key', message: 'Enter the owner key first' };
    let r, j = null;
    try { r = await fetch('/api/tool', { method: 'POST', headers: { 'content-type': 'application/json', 'x-owner-key': team.key }, body: JSON.stringify({ tool, input }) }); j = await r.json(); }
    catch { throw { code: 'server_unavailable', message: 'Could not reach the workspace server.', retryable: true }; }
    if (!j) throw { code: 'server_unavailable', message: `The server answered ${r.status}.` };
    if (j.isError) throw { code: 'tool_error', message: j.text, result: { content: [{ type: 'text', text: j.text }] } };
    let payload = j.text; try { payload = JSON.parse(j.text); } catch { /* plain text */ }
    return { content: [{ type: 'text', text: j.text }], payload };
  } };
}
const agentName = id => (team.agents.find(a => a.id === id) || {}).name || id || '—';

/* ---- transport ---- */
async function tcall(tool, args, { owner = false } = {}) {
  const mcp = state.caps.mcp; if (!mcp) throw { code: 'no_mcp', message: 'This view has no connector access' };
  const input = {}; for (const [k, v] of Object.entries(args || {})) if (v !== undefined && v !== null && k !== 'owner_key') input[k] = v;   // JSON only: never send undefined/null
  if (owner) { if (!team.key) throw { code: 'need_key', message: 'Enter the owner key first' }; input.owner_key = team.key; }
  const res = await mcp.callTool(TEAM_SERVER, tool, input, { cache: false });
  return res.payload;
}
function terr(e) {
  const c = e && e.code;
  if (c === 'no_mcp') return 'Connector access isn’t available in this view.';
  if (c === 'need_key') return 'Enter your owner key at the top first.';
  if (c === 'server_not_connected') return `Add a connector named “${TEAM_SERVER}” in claude.ai → Settings → Connectors, then reload this page.`;
  if (c === 'selection_required') return `More than one “${TEAM_SERVER}” connector exists — choose one when asked, then reload.`;
  if (c === 'needs_reauth') return `Reconnect “${TEAM_SERVER}” in claude.ai → Settings → Connectors.`;
  if (c === 'not_in_manifest') return 'Access to the workspace connector was turned off for this page.';
  if (c === 'blocked_by_policy' || c === 'approval_required') return 'Your organisation’s policy blocks this connector action.';
  if (c === 'server_unavailable') return 'The workspace server didn’t answer. Try again in a moment.';
  if (c === 'cancelled') return 'Cancelled.';
  if (c === 'tool_error') {
    let body = null; try { body = JSON.parse(e.message); } catch { try { body = JSON.parse(e.result.content[0].text); } catch { /* not JSON */ } }
    if (body && body.error) return ({ conflict: 'Someone changed that file first — refresh and try again.', bad_owner_key: 'Wrong owner key.', owner_required: 'That needs the owner key.', locked: 'That file is leased to another agent.', not_owner: 'That file belongs to another agent — use a proposal.', not_configured: body.message, too_large: body.message }[body.error] || body.message || body.error);
  }
  return (e && e.message) || 'Something went wrong.';
}
async function tdo(label, fn) {
  if (team.busy) return; team.busy = label; renderTeamBody();
  try { const r = await fn(); team.busy = ''; return r; }
  catch (e) { team.busy = ''; renderTeamBody(); toast(terr(e)); if (e && (e.code === 'bad_owner_key' || /owner key/i.test(terr(e)))) $('#t-key') && $('#t-key').focus(); }
  finally { team.busy = ''; }
}

/* ---- data ---- */
async function teamRefresh() {
  if (team.standalone && !team.key) { team.status = 'error'; team.err = 'Enter your owner key above to open the workspace.'; renderTeamHead(); renderTeamBody(); return; }
  if (team.refreshing) return; team.refreshing = true;
  team.status = 'loading'; renderTeamHead();
  try {
    const me = await tcall('whoami');   // one call first: a wrong owner key must cost one attempt against the lockout, not seven
    const [agents, files, tasks, messages, approvals, checkpoints] = await Promise.all([
      tcall('list_agents'), tcall('list_files'), tcall('list_tasks'), tcall('get_messages', { limit: 100 }), tcall('list_approvals'), tcall('list_checkpoints')]);
    Object.assign(team, { me, agents, files, tasks, messages, approvals, checkpoints, status: 'ok', err: '' });
  } catch (e) { team.status = e && e.code === 'no_mcp' ? 'none' : 'error'; team.err = terr(e); team.errCode = e && e.code; }
  team.refreshing = false; renderTeamHead(); renderTeamBody();
}
const clearForm = (...ids) => ids.forEach(id => { delete team.form[id]; const el = document.getElementById(id); if (el) el.value = ''; });
const pendingCount = () => team.approvals.filter(a => a.status === 'pending').length;

/* ---- views ---- */
function viewTeam() {
  $('#view').innerHTML = `<section class="page team">
    <div id="t-head"></div>
    <div class="subnav" id="t-sub" role="tablist"></div>
    <div id="t-body"></div></section>`;
  renderTeamHead(); renderTeamBody();
  if (team.status === 'idle' && state.caps.mcp) teamRefresh(); else if (!state.caps.mcp) { team.status = 'none'; renderTeamHead(); renderTeamBody(); }
}
function renderTeamHead() {
  const h = $('#t-head'); if (!h) return; const s = team.status;
  const chip = s === 'ok' ? `<span class="tchip ok">Connected as ${esc(agentName(team.me && team.me.you.actor))}</span>` : s === 'loading' ? '<span class="tchip">Connecting…</span>' : s === 'none' ? '<span class="tchip bad">No connector access here</span>' : s === 'error' ? '<span class="tchip bad">Not connected</span>' : '<span class="tchip">Not connected</span>';
  const keyRow = `<div class="keyrow"><input id="t-key" type="password" autocomplete="off" placeholder="Owner key (needed to approve, write files, run the OpenAI agent)" value="${esc(team.key)}" aria-label="Owner key"><button class="btn ghost small" data-t="refresh">Refresh</button></div>`;
  const hasKey = !!$('#t-key'); if (hasKey && $('#t-head .keyrow')) { $('#t-head .tchipbox').innerHTML = chip; return; }
  h.innerHTML = `<div class="thead"><div><h2>Team</h2><p class="hint">Claude, ChatGPT and other agents share one workspace with you.</p></div><div class="tchipbox">${chip}</div></div>${keyRow}`;
}
function renderTeamBody() {
  const b = $('#t-body'); if (!b) return;
  const sub = $('#t-sub'); if (sub) sub.innerHTML = TEAM_SUBS.map(([k, l]) => `<button class="chip${team.sub === k ? ' on' : ''}" data-t="sub" data-k="${k}">${l}${k === 'approvals' && pendingCount() ? `<i>${pendingCount()}</i>` : ''}</button>`).join('');
  if (team.status !== 'ok') { b.innerHTML = teamSetup(); return; }
  $$('#t-body input[id], #t-body textarea[id], #t-body select[id]').forEach(el => { if (el.type !== 'file') team.form[el.id] = el.value; });   // keep half-typed forms across refreshes
  b.innerHTML = ({ chat: teamChat, tasks: teamTasks, files: teamFiles, approvals: teamApprovals, agents: teamAgents })[team.sub]();
  for (const [id, v] of Object.entries(team.form)) { const el = document.getElementById(id); if (el && b.contains(el) && v) el.value = v; }
  const log = $('#t-log'); if (log) log.scrollTop = log.scrollHeight;
}
function teamSetup() {
  if (team.status === 'loading' || team.status === 'idle') return '<div class="empty"><h2>Connecting…</h2></div>';
  if (team.standalone) return `<div class="empty"><h2>Open the team workspace</h2><p>${esc(team.err || 'Enter your owner key above.')}</p><p class="hint">The owner key is the OWNER_SECRET you set on the server. It is kept in this browser tab only and sent to this server with each request.</p><button class="btn" data-t="refresh">Open workspace</button></div>`;
  return `<div class="empty"><h2>Set up the workspace connector</h2>
    <p>${esc(team.err || 'The Team tab needs the Kitbash Workspace server.')}</p>
    <ol class="steps">
      <li>Deploy the Kitbash Workspace server (the Railway app in this project; its README has the steps) and set an owner key.</li>
      <li>In claude.ai → Settings → Connectors, add a custom connector named exactly <b>${esc(TEAM_SERVER)}</b> with the URL <code>https://&lt;your-app&gt;.up.railway.app/mcp</code>.</li>
      <li>On the approval page choose the agent this connection is (Claude) and enter your owner key. Then reload this page.</li>
    </ol>
    <p class="hint">ChatGPT connects to the same URL from its own settings. That connection is separate, and depends on your ChatGPT plan.</p>
    <button class="btn ghost" data-t="refresh">Try again</button></div>`;
}

const kindLabel = m => m.kind === 'handoff' ? 'handoff' : m.kind === 'system' ? 'system' : m.kind === 'review' ? 'review' : '';
function teamChat() {
  const msgs = team.messages.map(m => `<div class="msg from-${esc(m.sender)} k-${esc(m.kind)}"><div class="mh"><b>${esc(agentName(m.sender))}</b><span>→ ${esc(m.recipient === 'all' ? 'everyone' : agentName(m.recipient))}${m.task_id ? ` · task #${m.task_id}` : ''}${kindLabel(m) ? ` · ${kindLabel(m)}` : ''} · ${esc(ago(m.ts))}</span></div><div class="mb">${esc(m.body)}</div></div>`).join('');
  const canClaude = !!state.caps.sample;
  return `<div class="tlog" id="t-log">${msgs || '<p class="hint pad">No messages yet. Say something to an agent below.</p>'}</div>
  <div class="composer"><textarea id="t-draft" rows="3" placeholder="Message the team…">${esc(team.draft)}</textarea>
    <div class="row wrap"><label class="tolab">To <select id="t-to">${TO_OPTS.map(([k, l]) => `<option value="${k}"${team.to === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <button class="btn" data-t="send"${team.busy ? ' disabled' : ''}>${team.busy === 'send' ? 'Working…' : 'Send'}</button></div>
    <p class="hint">${team.to === 'chatgpt' ? 'ChatGPT reads this the next time it is connected to the workspace. It can’t be woken from here.' : team.to === 'openai-api' || team.to === 'both' ? 'The OpenAI agent runs on the server with only what is in this workspace — it doesn’t know your ChatGPT conversations.' : ''}${(team.to === 'claude' || team.to === 'both') && !canClaude ? ' Claude can’t be woken from here; it sees this when it next connects to the workspace.' : ''}</p></div>`;
}
function teamTasks() {
  const asg = team.agents.filter(a => a.enabled && a.id !== 'owner');
  const opt = (sel) => `<option value="">unassigned</option>` + asg.map(a => `<option value="${esc(a.id)}"${a.id === sel ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
  const cards = team.tasks.map(t => {
    const live = !['done', 'cancelled'].includes(t.status);
    const run = live && t.assignee === 'openai-api' ? `<button class="btn small" data-t="run-task" data-id="${t.id}"${team.busy ? ' disabled' : ''}>Run OpenAI agent</button>` : live && t.assignee === 'claude' && state.caps.sample ? `<button class="btn small" data-t="claude-task" data-id="${t.id}"${team.busy ? ' disabled' : ''}>Ask Claude to work on it</button>` : '';
    return `<article class="tcard"><div class="row wrap"><b>#${t.id} ${esc(t.title)}</b><span class="tchip st-${esc(t.status)}">${esc(t.status.replace('_', ' '))}</span></div>
      ${t.description ? `<p class="hint">${esc(t.description)}</p>` : ''}
      <p class="meta">${t.assignee ? `with ${esc(agentName(t.assignee))}` : 'unassigned'} · by ${esc(agentName(t.created_by))}${t.files.length ? ` · files: ${t.files.map(esc).join(', ')}` : ''}</p>
      ${live ? `<div class="row wrap"><select data-t="hand-sel" data-id="${t.id}" aria-label="Hand off to">${asg.filter(a => a.id !== t.assignee).map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select><button class="btn ghost small" data-t="handoff" data-id="${t.id}"${team.busy ? ' disabled' : ''}>Hand off</button>
      <select data-t="status" data-id="${t.id}" aria-label="Status">${['open', 'in_progress', 'review', 'blocked', 'done', 'cancelled'].map(s => `<option${s === t.status ? ' selected' : ''}>${s}</option>`).join('')}</select>${run}</div>` : ''}</article>`;
  }).join('');
  return `<div class="tnew"><input id="tk-title" placeholder="New task title"><div class="row wrap"><select id="tk-asg">${opt('')}</select><input id="tk-files" placeholder="Files it may touch (comma separated, optional)"></div><button class="btn small" data-t="new-task"${team.busy ? ' disabled' : ''}>Create task</button></div>
    ${cards || '<p class="hint pad">No tasks yet.</p>'}`;
}
function teamFiles() {
  const rows = team.files.map(f => `<button class="frow${team.openFile && team.openFile.path === f.path ? ' on' : ''}" data-t="open-file" data-path="${esc(f.path)}"><span class="fp">${esc(f.path)}</span><span class="meta">r${f.rev} · ${esc(f.format)} · ${esc(agentName(f.owner))}${f.lease ? ` · leased to ${esc(agentName(f.lease.holder))}` : ''} · ${f.size} B</span></button>`).join('');
  const of = team.openFile;
  const view = of ? `<div class="fview"><div class="row wrap"><b>${esc(of.path)}</b><span class="meta">rev ${of.rev} · ${esc(of.format)} · ${esc(of.encoding)} · sha ${esc(String(of.sha).slice(0, 10))}</span></div><pre>${esc(of.encoding === 'utf8' ? of.content.slice(0, 6000) + (of.content.length > 6000 ? '\n… (' + of.content.length + ' chars)' : '') : `[binary, ${of.content.length} base64 chars]`)}</pre></div>` : '';
  const parts = all().slice(0, 300).map(s => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(kindInfo(s.kind)[2])})</option>`).join('');
  const cps = team.checkpoints.length ? `<p class="hint">Checkpoints: ${team.checkpoints.slice(0, 5).map(c => `#${c.id}${c.label ? ' ' + esc(c.label) : ''} (${esc(ago(c.ts))})`).join(' · ')}</p>` : '';
  return `${rows || '<p class="hint pad">No files yet. Import some below.</p>'}${view}
    <div class="tnew"><b>Import files as resources</b><p class="hint">Stored exactly as they are, with a format tag and revision history — NTree and NTN files are kept as opaque resources.</p>
      <input id="tf-tag" placeholder="Format tag, e.g. ntree/manifest or ntn/config (optional)">
      <div class="row wrap"><label class="btn ghost small filebtn">Choose files<input id="tf-files" type="file" multiple hidden></label><span class="hint">Saved under imports/ as you.</span></div></div>
    ${parts ? `<div class="tnew"><b>Share a part</b><div class="row wrap"><select id="tp-sel">${parts}</select><button class="btn ghost small" data-t="share-part"${team.busy ? ' disabled' : ''}>Share to workspace</button></div></div>` : ''}
    <div class="tnew"><div class="row wrap"><input id="tc-label" placeholder="Checkpoint label (optional)"><button class="btn ghost small" data-t="checkpoint"${team.busy ? ' disabled' : ''}>Create checkpoint</button></div>${cps}</div>`;
}
function teamApprovals() {
  const pend = team.approvals.filter(a => a.status === 'pending'), done = team.approvals.filter(a => a.status !== 'pending');
  const card = a => { const p = a.payload || {}; return `<article class="tcard"><div class="row wrap"><b>#${a.id} ${esc(a.kind.replace('_', ' '))}</b><span class="tchip st-${esc(a.status)}">${esc(a.status)}</span></div>
    <p class="meta">from ${esc(agentName(a.requested_by))}${p.path ? ` · ${esc(p.path)}` : ''}${p.checkpoint_id ? ` · checkpoint #${p.checkpoint_id}` : ''} · ${esc(ago(a.ts))}</p>${a.reason ? `<p class="hint">${esc(a.reason)}</p>` : ''}
    ${p.content_preview !== undefined ? `<pre>${esc(String(p.content_preview).slice(0, 800))}</pre>` : ''}
    ${a.status === 'pending' ? `<div class="row wrap"><button class="btn small" data-t="decide" data-id="${a.id}" data-d="approve"${team.busy ? ' disabled' : ''}>Approve</button><button class="btn ghost small" data-t="decide" data-id="${a.id}" data-d="reject"${team.busy ? ' disabled' : ''}>Reject</button></div>` : `<p class="meta">decided by ${esc(agentName(a.decided_by))}</p>`}</article>`; };
  return `${pend.map(card).join('') || '<p class="hint pad">Nothing waiting for you. Agents can’t delete files, restore checkpoints or overwrite another agent’s work without asking here first.</p>'}
    ${done.length ? `<details><summary>${done.length} decided</summary>${done.slice(0, 20).map(card).join('')}</details>` : ''}`;
}
function teamAgents() {
  const rows = team.agents.map(a => `<article class="tcard"><div class="row wrap"><b>${esc(a.name)}</b><span class="tchip ${a.enabled ? 'ok' : 'bad'}">${a.enabled ? 'enabled' : 'disabled'}</span></div><p class="meta">${esc(a.id)} · ${esc(a.kind)}${a.last_seen ? ` · seen ${esc(ago(a.last_seen))}` : ' · never connected'}</p>${a.description ? `<p class="hint">${esc(a.description)}</p>` : ''}
    ${a.id !== 'owner' ? `<button class="btn ghost small" data-t="toggle-agent" data-id="${esc(a.id)}" data-on="${a.enabled ? 0 : 1}"${team.busy ? ' disabled' : ''}>${a.enabled ? 'Disable' : 'Enable'}</button>` : ''}</article>`).join('');
  return `${rows}<div class="tnew"><b>Register another agent</b><input id="ta-id" placeholder="id, e.g. gemini"><input id="ta-name" placeholder="Display name"><button class="btn small" data-t="reg-agent"${team.busy ? ' disabled' : ''}>Register</button>
    <p class="hint">Registering makes the identity available on the connector approval page. It gets no access until you approve a connection for it.</p></div>`;
}

/* ---- in-page Claude (agent identity: never carries the owner key) ---- */
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) : String(s));
async function askClaude(instruction, taskId) {
  const sample = state.caps.sample; if (!sample) throw { code: 'not_granted', message: 'Claude access isn’t available in this view' };
  const brief = await tcall('read_file', { path: 'project/BRIEF.md' }).then(f => clip(f.content, 6000)).catch(() => null);
  const ctxMsgs = team.messages.slice(-15).map(m => `#${m.id} ${m.sender}→${m.recipient}: ${clip(m.body, 500)}`).join('\n');
  const files = team.files.slice(0, 60).map(f => `${f.path} (r${f.rev}, ${f.format}, owner ${f.owner}${f.lease ? ', leased to ' + f.lease.holder : ''})`).join('\n');
  const task = taskId ? team.tasks.find(t => t.id === taskId) : null;
  const prompt = `You are "claude", one agent in the Kitbash shared workspace. Other agents (ChatGPT, an embedded OpenAI agent) and the human owner share it. You do not remember earlier conversations; everything you know is below or in the workspace.
Rules the server enforces on you: every write needs base_rev (0 to create, otherwise the revision you just read); you may only edit files you own or hold a lease on (claim_file works for files listed on a task assigned to you); otherwise use propose_change. You cannot delete files or approve anything. Keep imported NTree/NTN resources byte-exact.
Reply to the owner in plain, short prose. Your final text is posted to the log automatically, so don't call post_message for it; use post_message only to leave a note for another agent.
${brief ? `OWNER BRIEF:\n${brief}\n` : ''}FILES:\n${files || '(none)'}\nRECENT MESSAGES:\n${ctxMsgs || '(none)'}\n${task ? `TASK #${task.id} (assigned to you): ${task.title}\n${task.description}\nFiles: ${task.files.join(', ') || 'none'}\nWhen done, use update_task (status review or done) or handoff_task with a note.\n` : ''}OWNER SAYS: ${instruction}`;
  const S = (n, d, props, req) => ({ name: n, description: d, inputSchema: { type: 'object', properties: props, required: req || [] }, execute: async (a) => {
    try { const r = await tcall(n, a || {}); const txt = typeof r === 'string' ? r : JSON.stringify(r); return txt.length > 12000 ? { truncated: true, text: txt.slice(0, 12000) } : (typeof r === 'string' ? { text: r } : r); }
    catch (e) { return { error: terr(e) }; } } });
  const str = { type: 'string' }, int = { type: 'integer' };
  const tools = [
    S('list_files', 'List workspace files.', { prefix: str }), S('read_file', 'Read a file (returns content, rev).', { path: str }, ['path']),
    S('write_file', 'Create (base_rev 0) or update a file you own or have leased.', { path: str, content: str, base_rev: int, format: str, message: str }, ['path', 'content', 'base_rev']),
    S('propose_change', 'Propose new content for a file you can’t edit; the owner approves.', { path: str, content: str, base_rev: int, rationale: str }, ['path', 'content', 'base_rev']),
    S('claim_file', 'Lease a file for a task assigned to you.', { path: str, task_id: int }, ['path']),
    S('create_task', 'Create a task.', { title: str, description: str, assignee: str, files: { type: 'array', items: str } }, ['title']),
    S('update_task', 'Change a task’s status/note.', { id: int, status: { type: 'string', enum: ['open', 'in_progress', 'review', 'blocked', 'done', 'cancelled'] }, note: str }, ['id']),
    S('handoff_task', 'Hand your task to another agent.', { id: int, to: str, note: str }, ['id', 'to']),
    S('post_message', 'Leave a note for another agent.', { to: str, body: str, task_id: int }, ['to', 'body'])
  ];
  const res = await sample(prompt, { tools, modelTier: 'default', cache: false });
  const text = (res.text || '').trim();
  if (text) await tcall('post_message', { to: 'owner', body: clip(text, 7500), task_id: taskId || undefined });
}
const askClaudeSafe = (text, taskId) => askClaude(text, taskId).catch(e => { if (e && e.code === 'not_granted') state.caps.sample = null; toast(e && e.code === 'not_granted' ? 'Claude access wasn’t granted' : terr(e)); });

/* ---- actions ---- */
async function fileToPayload(f) {
  const buf = new Uint8Array(await f.arrayBuffer());
  try { return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf), encoding: 'utf8' }; }
  catch { let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return { content: btoa(bin), encoding: 'base64' }; }
}
async function putFile(path, body, format, encoding, meta) {
  const cur = team.files.find(f => f.path === path);
  return tcall('write_file', { path, content: body, base_rev: cur ? cur.rev : 0, format, encoding, meta, message: 'Imported from Kitbash' }, { owner: true });
}
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-t]'); if (!t || state.tab !== 'team') return; const a = t.dataset.t; const id = +t.dataset.id;
  switch (a) {
    case 'refresh': team.status = 'idle'; if (state.caps.mcp) await teamRefresh(); else { team.status = 'none'; renderTeamHead(); renderTeamBody(); } break;
    case 'sub': team.sub = t.dataset.k; renderTeamBody(); break;
    case 'send': {
      const text = ($('#t-draft').value || '').trim(); if (!text) return toast('Type a message first.');
      const to = team.to, dest = to === 'both' ? 'all' : to;
      await tdo('send', async () => {
        await tcall('post_message', { to: dest, body: text }, { owner: true }); team.draft = ''; clearForm('t-draft');
        await teamRefresh();
        if (to === 'claude' || to === 'both') { if (state.caps.sample) await askClaudeSafe(text); else toast('Left in Claude’s inbox — it replies when it connects to the workspace'); }
        if (to === 'openai-api' || to === 'both') { try { await tcall('run_agent', { instruction: text }, { owner: true }); } catch (err) { toast(terr(err)); } }
        if (to === 'chatgpt') toast('Left in ChatGPT’s inbox');
      }); await teamRefresh(); break;
    }
    case 'new-task': { const title = $('#tk-title').value.trim(); if (!title) return toast('Give the task a title.'); const files = $('#tk-files').value.split(',').map(s => s.trim()).filter(Boolean);
      await tdo('task', async () => { await tcall('create_task', { title, assignee: $('#tk-asg').value || undefined, files }, { owner: true }); clearForm('tk-title', 'tk-files'); }); await teamRefresh(); break; }
    case 'handoff': { const to = $(`[data-t="hand-sel"][data-id="${id}"]`).value; if (!to) return; await tdo('handoff', () => tcall('handoff_task', { id, to, note: 'Handed off from the Team tab' }, { owner: true })); await teamRefresh(); break; }
    case 'run-task': { const task = team.tasks.find(x => x.id === id); await tdo('run', async () => { const r = await tcall('run_agent', { task_id: id, instruction: task ? task.title : undefined }, { owner: true }); toast(`OpenAI agent: ${r.applied} action(s) applied${r.rejected && r.rejected.length ? `, ${r.rejected.length} rejected` : ''}`); }); await teamRefresh(); break; }
    case 'claude-task': { const task = team.tasks.find(x => x.id === id); await tdo('claude', () => askClaudeSafe(`Please work on task #${id}: ${task ? task.title : ''}`, id)); await teamRefresh(); break; }
    case 'open-file': await tdo('open', async () => { team.openFile = await tcall('read_file', { path: t.dataset.path }); }); renderTeamBody(); break;
    case 'share-part': { const s = state.skills[$('#tp-sel').value]; if (!s) return;
      await tdo('share', async () => { const r = await putFile(`parts/${s.id}.json`, JSON.stringify(s, null, 2), 'kitbash/part', 'utf8', { project: s.project, kind: s.kind }); toast(`Shared as ${r.path} rev ${r.rev}`); }); await teamRefresh(); break; }
    case 'checkpoint': await tdo('cp', async () => { const r = await tcall('create_checkpoint', { label: $('#tc-label').value.trim() || undefined }, { owner: true }); toast(`Checkpoint #${r.id} saved`); clearForm('tc-label'); }); await teamRefresh(); break;
    case 'decide': await tdo('decide', async () => { const r = await tcall('decide_approval', { id, decision: t.dataset.d }, { owner: true }); toast(t.dataset.d === 'approve' ? (r && r.status === 'stale' ? 'That file changed since — request marked stale' : 'Approved') : 'Rejected'); }); await teamRefresh(); break;
    case 'toggle-agent': await tdo('agent', () => tcall('set_agent_enabled', { id: t.dataset.id, enabled: t.dataset.on === '1' }, { owner: true })); await teamRefresh(); break;
    case 'reg-agent': { const aid = $('#ta-id').value.trim().toLowerCase(); if (!aid) return toast('Give the agent an id.'); await tdo('reg', async () => { await tcall('register_agent', { id: aid, name: $('#ta-name').value.trim() || aid, kind: 'custom' }, { owner: true }); clearForm('ta-id', 'ta-name'); }); await teamRefresh(); break; }
  }
});
document.addEventListener('change', async e => {
  const t = e.target; if (state.tab !== 'team') return;
  if (t.id === 't-key') { if (team.status !== 'ok') teamRefresh(); }
  else if (t.id === 't-to') { team.to = t.value; team.draft = ($('#t-draft') || {}).value || ''; renderTeamBody(); }
  else if (t.dataset.t === 'status') { await tdo('status', () => tcall('update_task', { id: +t.dataset.id, status: t.value }, { owner: true })); await teamRefresh(); }
  else if (t.id === 'tf-files') {
    const list = [...t.files]; t.value = ''; if (!list.length) return; const tag = ($('#tf-tag').value || '').trim();
    await tdo('import', async () => {
      let n = 0, bad = 0;
      for (const f of list) {
        try { const p = await fileToPayload(f); const path = `imports/${(f.webkitRelativePath || f.name).replace(/^\/+/, '')}`; const ext = (f.name.split('.').pop() || 'bin').toLowerCase();
          await putFile(path, p.content, tag || `file/${ext}`, p.encoding, { original_name: f.name, original_size: f.size, imported_at: Date.now() }); n++;
          const k = team.files.find(x => x.path === path); if (k) k.rev++; else team.files.push({ path, rev: 1 });
        } catch (err) { bad++; toast(`${f.name}: ${terr(err)}`); }
      }
      toast(`Imported ${n} file${n === 1 ? '' : 's'}${bad ? `, ${bad} failed` : ''}`);
    }); await teamRefresh();
  }
});
document.addEventListener('input', e => {
  if (e.target.id === 't-key') { team.key = e.target.value; try { sessionStorage.setItem('kb-owner-key', team.key); } catch { /* ignore */ } }
  else if (e.target.id === 't-draft') team.draft = e.target.value;
});

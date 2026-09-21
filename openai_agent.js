// Embedded OpenAI agent. Runs inside the Worker when the owner asks (run_agent), calls the OpenAI API,
// and applies the model's structured answer through the SAME service functions every other agent uses,
// under its own fixed identity. It therefore cannot skip ownership, lease, conflict or approval checks.
import * as S from './service.js';

const SYSTEM = `You are "openai-api", an embedded agent inside the Kitbash shared workspace. You are called through the OpenAI API by the project owner.
You are NOT the ChatGPT app and you do NOT remember any ChatGPT conversation. Everything you know about this project is in the JSON you receive: the owner's brief, the file list, recent workspace messages, and your task. If something you need is missing, say so in a message instead of guessing.
Other agents (Claude, ChatGPT) work in the same workspace. Rules the server enforces on you:
- You may only change files you own or hold a lease on. Files on your task have already been leased to you if the task authorises them.
- Every write must name base_rev, the revision you saw. If it is stale the write is rejected.
- You cannot delete files or restore checkpoints. Use "proposals" to suggest changes to files you cannot edit.
- Files can be opaque resources (NTree/NTN formats). Never reformat them; only change what the task requires.
Answer with one JSON object only, with these optional keys:
{"messages":[{"to":"owner|claude|chatgpt|all","body":"..."}],
 "writes":[{"path":"...","content":"full new file content","base_rev":0,"format":"optional tag","message":"why"}],
 "proposals":[{"path":"...","content":"...","base_rev":1,"rationale":"..."}],
 "task":{"status":"in_progress|review|blocked|done","note":"..."},
 "handoff":{"to":"claude|chatgpt|...","note":"what is done and what the next agent should do"}}
Keep messages short. Only include writes the task actually requires.`;

const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);

export async function runOpenAIAgent(env, ownerCtx, { agent_id = 'openai-api', task_id, instruction } = {}) {
  const agent = await S.getAgent(env, agent_id);
  if (!agent || agent.kind !== 'openai-api' || !agent.enabled) throw new S.WsError('unknown_agent', `${agent_id} is not an enabled embedded OpenAI agent`);
  if (!env.OPENAI_API_KEY) throw new S.WsError('not_configured', 'OPENAI_API_KEY is not set on the Worker (wrangler secret put OPENAI_API_KEY)');
  if (!env.OPENAI_MODEL) throw new S.WsError('not_configured', 'OPENAI_MODEL is not set (a model your OpenAI key can call)');
  const ctx = await S.serverCtx(env, agent.id);

  let task = null; const taskFiles = {}; const knownRev = {};
  if (task_id !== undefined && task_id !== null) {
    task = await S.getTask(ctx, task_id);
    if (task.assignee !== agent.id) throw new S.WsError('not_assigned', `Task ${task_id} is assigned to ${task.assignee || 'nobody'}. Hand it to ${agent.id} first.`);
    if (['done', 'cancelled'].includes(task.status)) throw new S.WsError('bad_status', `Task ${task_id} is ${task.status}`);
  }
  const claims = [];
  for (const path of task ? task.files : []) {
    try { const l = await S.claimFile(ctx, { path, task_id }); claims.push({ path, holder: l.holder }); } catch (e) { if (!(e instanceof S.WsError)) throw e; claims.push({ path, error: e.code }); }
    try { const f = await S.readFile(ctx, { path }); knownRev[path] = f.rev; taskFiles[path] = { rev: f.rev, format: f.format, owner: f.owner, content: f.encoding === 'utf8' ? clip(f.content, 20_000) : '[base64 data omitted]', truncated: f.content.length > 20_000 }; } catch (e) { if (!(e instanceof S.WsError)) throw e; }
  }
  let brief = null; try { brief = clip((await S.readFile(ctx, { path: 'project/BRIEF.md' })).content, 8000); } catch { /* no brief yet */ }
  const files = (await S.listFiles(ctx, {})).slice(0, 100).map((f) => ({ path: f.path, rev: f.rev, format: f.format, owner: f.owner, lease: f.lease && f.lease.holder }));
  const messages = (await S.getMessages(ctx, { limit: 20 })).map((m) => ({ id: m.id, from: m.sender, to: m.recipient, kind: m.kind, task: m.task_id, body: clip(m.body, 1500) }));
  const input = { you: agent.id, owner_brief: brief, owner_instruction: instruction || null, task, task_files: taskFiles, workspace_files: files, recent_messages: messages };

  const base = String(env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  let resp;
  try {
    resp = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: env.OPENAI_MODEL, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(input) }] }) });
  } catch (e) { throw new S.WsError('upstream_error', 'Could not reach the OpenAI API'); }
  if (!resp.ok) throw new S.WsError('upstream_error', `OpenAI API returned ${resp.status}: ${clip(await resp.text().catch(() => ''), 300)}`);
  const data = await resp.json();
  let actions;
  try { actions = JSON.parse(data.choices[0].message.content); } catch { throw new S.WsError('bad_model_output', 'The model did not return valid JSON'); }

  const report = { applied: [], rejected: [], claims };
  const attempt = async (label, fn) => { try { report.applied.push({ label, result: await fn() }); } catch (e) { if (!(e instanceof S.WsError)) throw e; report.rejected.push({ label, error: e.code, message: e.message }); } };
  for (const w of (Array.isArray(actions.writes) ? actions.writes : []).slice(0, 10)) {
    await attempt(`write ${w && w.path}`, () => S.writeFile(ctx, { path: w.path, content: w.content, base_rev: Number.isInteger(w.base_rev) ? w.base_rev : (knownRev[w.path] ?? 0), format: w.format, message: w.message || `Run for task ${task_id ?? '-'}` }));
  }
  for (const p of (Array.isArray(actions.proposals) ? actions.proposals : []).slice(0, 5)) {
    await attempt(`propose ${p && p.path}`, () => S.proposeChange(ctx, { path: p.path, content: p.content, base_rev: p.base_rev, rationale: p.rationale }));
  }
  for (const m of (Array.isArray(actions.messages) ? actions.messages : []).slice(0, 5)) {
    await attempt('message', () => S.postMessage(ctx, { to: m.to || 'all', body: String(m.body || ''), task_id: task ? task.id : undefined }));
  }
  if (task && actions.task && actions.task.status) await attempt(`task ${actions.task.status}`, () => S.updateTask(ctx, { id: task.id, status: actions.task.status, note: actions.task.note }));
  if (task && actions.handoff && actions.handoff.to) await attempt(`handoff to ${actions.handoff.to}`, () => S.handoffTask(ctx, { id: task.id, to: actions.handoff.to, note: actions.handoff.note }));
  if (report.rejected.length) {
    await S.postMessage(ctx, { to: 'owner', kind: 'note', body: `Run finished with ${report.rejected.length} rejected action(s): ` + report.rejected.map((r) => `${r.label} → ${r.error}`).join('; '), task_id: task ? task.id : undefined });
  }
  return { agent: agent.id, model: env.OPENAI_MODEL, task_id: task ? task.id : null, applied: report.applied.length, rejected: report.rejected, details: report.applied.map((a) => a.label), claims, usage: data.usage || null };
}

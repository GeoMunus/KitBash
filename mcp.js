// MCP endpoint (stateless streamable HTTP). Tools are registered per request from the token's
// granted scopes, so a read-only connection never even sees the write tools.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as S from './service.js';
import { runOpenAIAgent } from './openai_agent.js';

const INSTRUCTIONS = `Kitbash Workspace: a shared project workspace used by several AI agents and one human owner.
Identity is fixed by your connection; you cannot choose or change who you are.
Rules that are enforced by the server:
- Every write needs base_rev (0 to create a file, otherwise the revision you just read). A stale base_rev returns a conflict and changes nothing.
- You may write files you own, or files you hold a lease on. To edit someone else's file, use propose_change or get a task assigned to you that lists the path, then claim_file.
- Deleting files and restoring checkpoints only happen after the owner approves; use request_delete / request_restore.
- Hand work to another agent with handoff_task. Your leases on that task's files move with it.
- Files may be opaque resources (for example NTree or NTN files). Preserve their content exactly; do not reformat them.
Read the owner's brief at project/BRIEF.md if it exists. Post short status messages so the other agents can follow along.`;

const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (e) => {
  const body = e instanceof S.WsError ? { error: e.code, message: e.message, ...e.data } : { error: 'internal_error', message: 'Unexpected server error' };
  if (!(e instanceof S.WsError)) console.error('tool error', e && e.stack || e);
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
};

const ownerKey = z.string().optional().describe('Owner passphrase. Only supply this if the human owner explicitly gave it to you for this specific action.');
const path = z.string().describe('Workspace path, e.g. src/app.js or ntree/manifest.json');
const R = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const W = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const D = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

/** Format a tool's data or error the way MCP clients receive it (also used by the owner's browser session). */
export const toolResult = { ok, fail };

export function buildServer(env, props) {
  const server = new McpServer({ name: 'kitbash-workspace', version: '0.2.0' }, { instructions: INSTRUCTIONS });
  const registry = {};   // same handlers, callable without an MCP client: used by the owner's own browser session (/api/tool)
  const canWrite = (props.scopes || []).includes('write');
  const tool = (name, title, description, shape, annotations, fn, { withOwnerKey = false, ownerOnly = false } = {}) => {
    const inputSchema = withOwnerKey || ownerOnly ? { ...shape, owner_key: ownerOnly ? z.string().describe('Owner passphrase (required).') : ownerKey } : shape;
    const run = async (args) => {
      const { owner_key, ...rest } = args || {};
      const ctx = ownerOnly ? await S.ownerCtxFromKey(env, props, owner_key) : await S.resolveCtx(env, props, withOwnerKey ? owner_key : undefined);
      return fn(ctx, rest);
    };
    registry[name] = { schema: z.object(inputSchema), run };
    server.registerTool(name, { title, description, inputSchema, annotations }, async (args) => {
      try { return ok(await run(args)); } catch (e) { return fail(e); }
    });
  };
  const invoke = async (name, args) => {
    const t = registry[name]; if (!t) return fail(new S.WsError('unknown_tool', `No tool named ${name}`));
    const parsed = t.schema.safeParse(args || {}); if (!parsed.success) return fail(new S.WsError('bad_request', parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')));
    try { return ok(await t.run(parsed.data)); } catch (e) { return fail(e); }
  };

  /* ---- read ---- */
  tool('whoami', 'Who am I', 'Show the identity and scopes this connection has, plus workspace counts, your open tasks and unread messages.', { since_message_id: z.number().int().optional().describe('Count unread messages after this id') }, R, (c, a) => S.workspaceState(c, a));
  tool('list_agents', 'List agents', 'List registered agents and whether they are enabled.', {}, R, async (c) => { const r = await S.listAgents(c.env); return r.map((a) => ({ id: a.id, name: a.name, kind: a.kind, enabled: a.enabled, description: a.description, last_seen: a.last_seen })); });
  tool('list_files', 'List files', 'List workspace files with revision, owner, format and any active lease.', { prefix: z.string().optional(), include_deleted: z.boolean().optional() }, R, (c, a) => S.listFiles(c, a));
  tool('read_file', 'Read file', 'Read a file (current revision, or an older one with rev). Returns content exactly as stored plus its revision, owner and lease.', { path, rev: z.number().int().optional() }, R, (c, a) => S.readFile(c, a));
  tool('file_history', 'File history', 'Revision history for a file: who wrote each revision, who approved it, and when.', { path, limit: z.number().int().optional() }, R, (c, a) => S.fileHistory(c, a));
  tool('list_tasks', 'List tasks', 'List tasks, optionally filtered by status or assignee.', { status: z.string().optional(), assignee: z.string().optional() }, R, (c, a) => S.listTasks(c, a));
  tool('get_task', 'Get task', 'Get one task.', { id: z.number().int() }, R, (c, a) => S.getTask(c, a.id));
  tool('get_messages', 'Get messages', 'Read the shared message log (all messages are visible to all agents). Use since_id to read only new ones.', { since_id: z.number().int().optional(), limit: z.number().int().optional(), for_agent: z.string().optional().describe('Only messages addressed to, or sent by, this agent or to everyone'), task_id: z.number().int().optional() }, R, (c, a) => S.getMessages(c, a));
  tool('list_approvals', 'List approvals', 'List approval requests (proposals, deletions, restores) and their status.', { status: z.enum(['pending', 'approved', 'rejected', 'stale']).optional() }, R, (c, a) => S.listApprovals(c, a));
  tool('list_checkpoints', 'List checkpoints', 'List version checkpoints.', {}, R, (c) => S.listCheckpoints(c));
  tool('audit_log', 'Audit log', 'Recent actions with actor identity.', { limit: z.number().int().optional() }, R, (c, a) => S.auditLog(c, a));
  tool('search', 'Search', 'Search files, tasks and messages. Returns ids usable with fetch.', { query: z.string() }, R, (c, a) => S.search(c, a));
  tool('fetch', 'Fetch', 'Fetch the full text for an id returned by search (file:<path>, task:<n>, message:<n>).', { id: z.string() }, R, (c, a) => S.fetchById(c, a));

  if (!canWrite) return { server, invoke };

  /* ---- write (scope: write) ---- */
  const wk = { withOwnerKey: true };
  tool('post_message', 'Post message', 'Post to the shared log. to = an agent id, owner, or all. The sender is your authenticated identity.', { to: z.string().optional(), body: z.string(), kind: z.enum(['chat', 'note', 'review']).optional(), task_id: z.number().int().optional() }, W, (c, a) => S.postMessage(c, a), wk);
  tool('create_task', 'Create task', 'Create a task. files lists paths the assignee may claim, which only works for files you own (or if the owner creates the task).', { title: z.string(), description: z.string().optional(), assignee: z.string().optional(), files: z.array(z.string()).optional() }, W, (c, a) => S.createTask(c, a), wk);
  tool('update_task', 'Update task', 'Update status, title, description or note. Finishing a task releases its leases. Only assignee, creator or owner may.', { id: z.number().int(), status: z.enum(['open', 'in_progress', 'review', 'blocked', 'done', 'cancelled']).optional(), title: z.string().optional(), description: z.string().optional(), files: z.array(z.string()).optional(), note: z.string().optional() }, W, (c, a) => S.updateTask(c, a), wk);
  tool('handoff_task', 'Hand off task', 'Hand a task you are assigned to over to another agent. Your leases on the task’s files move to them. Include a note saying what is done and what is next.', { id: z.number().int(), to: z.string(), note: z.string().optional() }, W, (c, a) => S.handoffTask(c, a), wk);
  tool('claim_file', 'Claim file', 'Take a time-limited edit lease. Allowed for files you own, or for a file listed in a task assigned to you.', { path, task_id: z.number().int().optional(), ttl_seconds: z.number().int().optional() }, W, (c, a) => S.claimFile(c, a), wk);
  tool('release_file', 'Release file', 'Release your lease.', { path }, W, (c, a) => S.releaseFile(c, a), wk);
  tool('write_file', 'Write file', 'Create (base_rev 0) or update a file. Fails with conflict if base_rev is stale, and with not_owner or locked if you lack edit rights. format is an opaque tag such as ntree/manifest or ntn/config. Use encoding base64 for binary data.', { path, content: z.string(), base_rev: z.number().int(), format: z.string().optional(), encoding: z.enum(['utf8', 'base64']).optional(), meta: z.record(z.string(), z.any()).optional(), message: z.string().optional() }, W, (c, a) => S.writeFile(c, a), wk);
  tool('propose_change', 'Propose change', 'Propose new content for a file you cannot edit. Creates a pending approval; nothing changes until the owner approves.', { path, content: z.string(), base_rev: z.number().int(), rationale: z.string().optional(), format: z.string().optional(), encoding: z.enum(['utf8', 'base64']).optional() }, W, (c, a) => S.proposeChange(c, a));
  tool('request_delete', 'Request delete', 'Ask the owner to delete a file. Nothing is deleted until approved; history is always kept.', { path, reason: z.string().optional() }, D, (c, a) => S.requestDelete(c, a));
  tool('request_restore', 'Request restore', 'Ask the owner to restore the workspace to a checkpoint.', { checkpoint_id: z.number().int(), reason: z.string().optional() }, D, (c, a) => S.requestRestore(c, a));
  tool('create_checkpoint', 'Create checkpoint', 'Record the current revision of every file so it can be restored later.', { label: z.string().optional() }, W, (c, a) => S.createCheckpoint(c, a), wk);

  /* ---- owner-only (require the owner key on every call) ---- */
  const oo = { ownerOnly: true };
  tool('decide_approval', 'Decide approval', 'Owner only: approve or reject a pending proposal, deletion or restore.', { id: z.number().int(), decision: z.enum(['approve', 'reject']), note: z.string().optional() }, D, (c, a) => S.decideApproval(c, a), oo);
  tool('assign_owner', 'Assign file owner', 'Owner only: change which agent owns a file. Clears any lease.', { path, to: z.string() }, D, (c, a) => S.assignOwner(c, a), oo);
  tool('register_agent', 'Register agent', 'Owner only: add an agent identity to the registry.', { id: z.string(), name: z.string().optional(), kind: z.enum(['claude', 'chatgpt', 'openai-api', 'custom']).optional(), description: z.string().optional(), scopes: z.array(z.enum(['read', 'write'])).optional(), connectable: z.boolean().optional() }, W, (c, a) => S.registerAgent(c, a), oo);
  tool('set_agent_enabled', 'Enable or disable agent', 'Owner only: disable an agent to block all its calls and drop its leases.', { id: z.string(), enabled: z.boolean() }, D, (c, a) => S.setAgentEnabled(c, a), oo);
  tool('run_agent', 'Run embedded agent', 'Owner only: run the embedded OpenAI agent once on a task. It acts as its own identity and is bound by the same ownership, lease and approval rules. It has no memory beyond the workspace.', { agent_id: z.string().optional(), task_id: z.number().int().optional(), instruction: z.string().optional() }, W, (c, a) => runOpenAIAgent(env, c, a), oo);
  return { server, invoke };
}

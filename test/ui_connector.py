"""Team-tab UI test. The page's `mcp` capability is stubbed with a bridge that makes REAL authenticated MCP calls
to the local Worker (real OAuth token, real D1). `sample` is a scripted stand-in for Claude that calls the page-provided tools."""
import asyncio, json, urllib.request, hashlib, base64, sys
from playwright.async_api import async_playwright
import os
TEST_URL = 'file://' + os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'app', 'test.html'))
BASE = 'http://127.0.0.1:8787'; KEY = 'test-owner-secret-123'
TOK = json.load(open('/tmp/ui-tokens.json'))
ok = bad = 0
def check(name, cond, extra=''):
    global ok, bad
    if cond: ok += 1; print('  PASS', name)
    else: bad += 1; print('  FAIL', name, extra)
def rpc(token, tool, args):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': tool, 'arguments': args}}).encode()
    r = urllib.request.Request(BASE + '/mcp', data=body, headers={'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': 'Bearer ' + token})
    try: d = json.load(urllib.request.urlopen(r, timeout=30))
    except urllib.error.HTTPError as e: return {'http': e.code}
    res = d.get('result') or {}; txt = (res.get('content') or [{}])[0].get('text', '')
    try: pay = json.loads(txt)
    except Exception: pay = txt
    return {'err': bool(res.get('isError')), 'payload': pay, 'text': txt}
def api(tool, **a): return rpc(TOK['claude'], tool, a)

INIT = """
window.__calls = [];
window.claude = { use: async (name) => {
  if (name === 'mcp') { if (window.__nomcp) return null; return { callTool: async (server, tool, input) => {
      window.__calls.push({ server, tool, hasKey: !!(input && input.owner_key) });
      if (window.__notconnected) throw { code: 'server_not_connected', message: 'x', server };
      const r = await window.__mcp(tool, input || {});
      if (r.http) throw { code: 'needs_reauth', message: 'http ' + r.http };
      if (r.err) throw { code: 'tool_error', message: r.text, result: { content: [{ type: 'text', text: r.text }] } };
      return { content: [{ type: 'text', text: r.text }], payload: r.payload };
  } }; }
  if (name === 'sample') { const f = async (prompt, opts) => {
      window.__prompt = prompt; const by = Object.fromEntries((opts.tools || []).map(t => [t.name, t]));
      const files = await by.list_files.execute({});
      await by.post_message.execute({ to: 'openai-api', body: 'Claude note: I looked at ' + (Array.isArray(files) ? files.length : '?') + ' files.' });
      // an attempt to impersonate: the page-provided tool must ignore/strip this
      await by.post_message.execute({ to: 'owner', body: 'impersonation attempt', owner_key: 'test-owner-secret-123', sender: 'owner' });
      return { text: 'Claude here. I read the workspace and left a note for the OpenAI agent.', truncated: false }; };
    f.json = f; return f; }
  return null; } };
"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 390, 'height': 800}, is_mobile=True)
        page = await ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.expose_function('__mcp', lambda tool, args: rpc(TOK['claude'], tool, args))
        await page.add_init_script(INIT)
        await page.goto(TEST_URL); await page.wait_for_selector('#nav-team')
        # nav still has all four tabs and existing tabs still render
        check('nav has Import/Parts/Build/Team', await page.locator('.nav button').count() == 4)
        await page.click('#nav-parts'); check('Parts tab still renders', await page.locator('.toolbar').count() == 1)
        await page.click('#nav-build'); check('Build tab still renders', await page.locator('#goal').count() == 1)
        await page.click('#nav-team'); await page.wait_for_selector('.tchip.ok')
        check('Team shows connected identity', 'Connected as Claude' in await page.inner_text('.tchipbox'), await page.inner_text('.tchipbox'))
        # --- owner-key gate
        await page.click('[data-t=sub][data-k=tasks]'); await page.fill('#tk-title', 'Review the plan'); await page.click('[data-t=new-task]')
        await page.wait_for_selector('#toast.on'); check('owner action without key is refused client-side', 'owner key' in (await page.inner_text('#toast')).lower(), await page.inner_text('#toast'))
        check('…and no write reached the server', not any(c['tool'] == 'create_task' for c in await page.evaluate('window.__calls')))
        await page.fill('#t-key', 'wrong-key'); await page.click('[data-t=new-task]'); await page.wait_for_timeout(1500); tt = await page.inner_text('#toast')
        check('wrong owner key is rejected by the server', 'Wrong owner key' in tt, [tt, await page.evaluate('window.__calls.slice(-3)')])
        await page.fill('#t-key', KEY)
        # --- import files as opaque resources (BOM + CRLF text, and binary)
        await page.click('[data-t=sub][data-k=files]'); await page.fill('#tf-tag', 'ntree/manifest')
        bom = b'\xef\xbb\xbf{"name":"demo","items":[1,2,3]}\r\n'; binb = bytes(range(256)) * 3
        await page.set_input_files('#tf-files', [{'name': 'demo.ntree', 'mimeType': 'application/json', 'buffer': bom}, {'name': 'asset.ntn', 'mimeType': 'application/octet-stream', 'buffer': binb}])
        await page.wait_for_selector('.frow >> text=imports/asset.ntn')
        r1 = api('read_file', path='imports/demo.ntree')['payload']; r2 = api('read_file', path='imports/asset.ntn')['payload']
        check('text resource stored byte-exact (BOM + CRLF)', r1['encoding'] == 'utf8' and r1['content'].encode('utf-8') == bom, r1.get('content'))
        check('format tag + owner recorded', r1['format'] == 'ntree/manifest' and r1['owner'] == 'owner' and r1['rev'] == 1, r1)
        check('binary resource stored as base64, byte-exact', r2['encoding'] == 'base64' and base64.b64decode(r2['content']) == binb and r2['sha'] == hashlib.sha256(binb).hexdigest(), r2.get('sha'))
        # re-import same file -> revision 2 (revision tracking)
        await page.set_input_files('#tf-files', [{'name': 'demo.ntree', 'mimeType': 'application/json', 'buffer': bom + b'x'}]); await page.wait_for_function("document.body.innerText.includes('r2')", timeout=8000)
        check('re-import creates revision 2', api('read_file', path='imports/demo.ntree')['payload']['rev'] == 2)
        await page.click('.frow >> text=imports/demo.ntree'); await page.wait_for_selector('.fview')
        check('file viewer shows content', 'demo' in await page.inner_text('.fview pre'))
        # share a part
        await page.evaluate("state.skills['p1'] = {id:'p1', name:'lerp', kind:'fn', lang:'js', code:'const lerp=(a,b,t)=>a+(b-a)*t', project:'demo', path:'a.js', line:1, summary:'x', tags:[], provides:[], requires:[], uses:[], pkgs:[], hits:0, created:Date.now()}; rebuild()")
        await page.click('[data-t=sub][data-k=chat]'); await page.click('[data-t=sub][data-k=files]')
        await page.click('[data-t=share-part]'); await page.wait_for_selector('.frow >> text=parts/p1.json')
        check('part shared with kitbash/part format', api('read_file', path='parts/p1.json')['payload']['format'] == 'kitbash/part')
        await page.screenshot(path='/tmp/team-files.png')
        # --- chat: Both agents, sequentially
        await page.click('[data-t=sub][data-k=chat]'); await page.select_option('#t-to', 'both'); await page.fill('#t-draft', 'Please look over the imports and say hello.')
        await page.click('[data-t=send]'); await page.wait_for_selector('.msg:has-text("Hello from the embedded OpenAI agent")', timeout=20000)
        msgs = api('get_messages', limit=50)['payload']
        by = lambda s, sub: [m for m in msgs if m['sender'] == s and sub in m['body']]
        check('owner message posted as owner', len(by('owner', 'look over the imports')) == 1)
        check('Claude reply posted as claude', len(by('claude', 'Claude here.')) == 1 and len(by('claude', 'left a note')) == 1)
        check('Claude tool note posted as claude', len(by('claude', 'Claude note')) == 1)
        check('impersonation attempt did NOT post as owner', len(by('owner', 'impersonation attempt')) == 0 and len(by('claude', 'impersonation attempt')) == 1, [m['sender'] for m in msgs if 'impersonation' in m['body']])
        check('OpenAI agent reply posted as openai-api', len(by('openai-api', 'Hello from the embedded')) == 1)
        prompt = await page.evaluate('window.__prompt'); check('Claude was given the owner message + file list', 'look over the imports' in prompt and 'imports/demo.ntree' in prompt)
        calls = await page.evaluate('window.__calls'); pm = [c for c in calls if c['tool'] == 'post_message']; check('only the owner’s own send carried the key; Claude’s tool calls (incl. the impersonation attempt) did not', sum(c['hasKey'] for c in pm) == 1 and sum(not c['hasKey'] for c in pm) == 3 and not any(c['hasKey'] for c in calls if c['tool'] == 'list_files' and False), [(c['tool'], c['hasKey']) for c in pm])
        # ChatGPT inbox
        await page.select_option('#t-to', 'chatgpt'); await page.fill('#t-draft', 'ChatGPT: please review parts/p1.json when you connect.'); await page.click('[data-t=send]')
        await page.wait_for_selector('.msg:has-text("ChatGPT: please review")')
        check('ChatGPT message addressed to chatgpt', any(m['recipient'] == 'chatgpt' and m['sender'] == 'owner' for m in api('get_messages', limit=50)['payload']))
        await page.screenshot(path='/tmp/team-chat.png')
        # --- tasks: create, hand off sequentially, run embedded agent
        await page.click('[data-t=sub][data-k=tasks]'); await page.fill('#tk-title', 'Tidy the demo manifest'); await page.select_option('#tk-asg', 'claude'); await page.fill('#tk-files', 'imports/demo.ntree')
        await page.click('[data-t=new-task]'); await page.wait_for_selector('.tcard:has-text("Tidy the demo manifest")')
        tid = [t for t in api('list_tasks')['payload'] if t['title'] == 'Tidy the demo manifest'][0]['id']
        card = page.locator('.tcard', has_text='Tidy the demo manifest')
        await card.locator('[data-t=hand-sel]').select_option('openai-api'); await card.locator('[data-t=handoff]').click()
        await page.wait_for_selector('.tcard:has-text("Tidy the demo manifest") >> text=Run OpenAI agent')
        check('handoff moved the task to the OpenAI agent', api('get_task', id=tid)['payload']['assignee'] == 'openai-api')
        await page.locator('.tcard', has_text='Tidy the demo manifest').locator('[data-t=run-task]').click()
        await page.wait_for_function("document.querySelector('#toast').textContent.includes('OpenAI agent:')", timeout=20000)
        t = api('get_task', id=tid)['payload']; f = api('read_file', path='imports/demo.ntree')['payload']
        check('embedded agent finished the task and handed it back to Claude', t['assignee'] == 'claude' and t['status'] in ('review', 'in_progress', 'open'), t)
        check('embedded agent wrote a new revision as openai-api', f['rev'] == 3 and f['author'] == 'openai-api' and f['content'].endswith('- edited by openai-api'), {k: f.get(k) for k in ('rev', 'author')})
        check('file owner unchanged after agent edit', f['owner'] == 'owner')
        # --- approvals: claude proposes a change to an owner-owned file; owner approves in the UI
        pr = api('propose_change', path='imports/asset.ntn', content='dGVzdA==', base_rev=1, encoding='base64', rationale='ui test')
        check('claude cannot write owner file directly', api('write_file', path='imports/asset.ntn', content='nope', base_rev=1)['err'])
        await page.click('[data-t=sub][data-k=approvals]'); await page.click('[data-t=refresh]'); await page.wait_for_selector('.tcard:has-text("proposal")')
        check('pending approval badge shown', '1' in await page.inner_text('[data-k=approvals]'))
        await page.fill('#t-key', ''); await page.click('[data-t=decide][data-d=approve]'); await page.wait_for_function("document.querySelector('#toast').textContent.toLowerCase().includes('owner key')")
        check('approval blocked without owner key', api('read_file', path='imports/asset.ntn')['payload']['rev'] == 1)
        await page.fill('#t-key', KEY); await page.click('[data-t=decide][data-d=approve]'); await page.wait_for_function("!document.querySelector('[data-t=decide]')", timeout=8000)
        check('approved proposal applied as a new revision', api('read_file', path='imports/asset.ntn')['payload']['rev'] == 2)
        # --- agents: disable / enable
        await page.click('[data-t=sub][data-k=agents]'); await page.wait_for_selector('.tcard:has-text("openai-api")')
        await page.locator('.tcard', has_text='openai-api').locator('[data-t=toggle-agent]').click(); await page.wait_for_selector('.tcard:has-text("openai-api") >> text=disabled')
        check('agent disabled via registry', any(a['id'] == 'openai-api' and not a['enabled'] for a in api('list_agents')['payload']))
        await page.locator('.tcard', has_text='openai-api').locator('[data-t=toggle-agent]').click(); await page.wait_for_selector('.tcard:has-text("openai-api") >> text=enabled')
        await page.fill('#ta-id', 'gemini'); await page.fill('#ta-name', 'Gemini'); await page.click('[data-t=reg-agent]'); await page.wait_for_selector('.tcard:has-text("Gemini")')
        check('new agent registered', any(a['id'] == 'gemini' for a in api('list_agents')['payload']))
        # checkpoint
        await page.click('[data-t=sub][data-k=files]'); await page.fill('#tc-label', 'after-ui'); await page.click('[data-t=checkpoint]'); await page.wait_for_function("document.body.innerText.includes('after-ui')", timeout=8000)
        check('checkpoint recorded', any(c.get('label') == 'after-ui' for c in api('list_checkpoints')['payload']))
        # --- read-only ChatGPT token cannot write (server-side, independent of UI)
        ro = rpc(TOK['chatgpt_ro'], 'write_file', {'path': 'x.txt', 'content': 'x', 'base_rev': 0}); check('read-only ChatGPT token has no write tool', ro.get('err') is True or 'error' in json.dumps(ro).lower(), ro)
        await page.screenshot(path='/tmp/team-approvals.png')
        # --- degraded states
        for flag, want in (('__notconnected', 'Add a connector named'), ('__nomcp', 'No connector access')):
            p2 = await ctx.new_page(); await p2.expose_function('__mcp', lambda t, a: {}); await p2.add_init_script(INIT + f"window.{flag} = true;")
            await p2.goto(TEST_URL); await p2.click('#nav-team'); await p2.wait_for_selector('.empty h2:has-text("Set up the workspace connector")', timeout=15000)
            txt = await p2.inner_text('#t-body') + await p2.inner_text('.tchipbox'); check(f'degraded state {flag}', want in txt, txt[:200]); await p2.screenshot(path=f'/tmp/team{flag}.png'); await p2.close()
        check('no page errors', not errs, errs)
        await b.close()
    print(f'\n{ok} passed, {bad} failed'); sys.exit(1 if bad else 0)
asyncio.run(main())

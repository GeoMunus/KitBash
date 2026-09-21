"""Standalone Team-tab test: a real browser opens Kitbash FROM the workspace server (no stubs, no window.claude at all).
The page talks to /api/tool with the owner key, exactly as a phone browser pointed at the Railway URL would."""
import asyncio, json, urllib.request, hashlib, base64, sys
from playwright.async_api import async_playwright
BASE = 'http://127.0.0.1:8787'; KEY = 'test-owner-secret-123'
TOK = json.load(open('/tmp/ui-tokens.json'))
ok = bad = 0
def check(name, cond, extra=''):
    global ok, bad
    if cond: ok += 1; print('  PASS', name)
    else: bad += 1; print('  FAIL', name, extra)
def http(method, path, body=None, headers=None):
    r = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), method=method, headers={'content-type': 'application/json', **(headers or {})})
    try:
        resp = urllib.request.urlopen(r, timeout=30); return resp.status, resp.read().decode(), dict(resp.headers)
    except urllib.error.HTTPError as e: return e.code, e.read().decode(), dict(e.headers)
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
def owner(tool, **a):
    s, t, _ = http('POST', '/api/tool', {'tool': tool, 'input': a}, {'x-owner-key': KEY}); j = json.loads(t)
    try: pay = json.loads(j['text'])
    except Exception: pay = j['text']
    return {'status': s, 'err': j['isError'], 'payload': pay}

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 390, 'height': 800}, is_mobile=True)
        page = await ctx.new_page(); errs = []; global PAGE; PAGE = page
        page.on('pageerror', lambda e: errs.append(str(e)))
        # --- server-side auth of the owner endpoint, independent of the UI
        s, _, _ = http('POST', '/api/tool', {'tool': 'list_files', 'input': {}}); check('/api/tool without a key is 401', s == 401, s)
        s, _, _ = http('POST', '/api/tool', {'tool': 'list_files', 'input': {}}, {'x-owner-key': 'nope'}); check('/api/tool with a wrong key is 401', s == 401, s)
        s, _, _ = http('POST', '/api/tool', {'tool': 'list_files', 'input': {}}, {'authorization': 'Bearer ' + TOK['claude']}); check('an agent’s OAuth token does not open the owner endpoint', s == 401, s)
        s, t, h = http('GET', '/'); check('app is served at / as HTML with the standalone marker', s == 200 and 'kitbash-server' in t and 'Kitbash' in t and h.get('Content-Type', '').startswith('text/html'))
        s, t, _ = http('GET', '/health'); hj = json.loads(t); check('/health reports database persistence and no warnings', hj['ok'] and hj['database']['persistent'] is True and hj['warnings'] == [], hj)
        # --- open the app from the server
        await page.goto(BASE + '/'); await page.wait_for_selector('#nav-team')
        check('nav has Import/Parts/Build/Team', await page.locator('.nav button').count() == 4)
        await page.click('#nav-parts'); check('Parts tab renders', await page.locator('.toolbar').count() == 1)
        await page.click('#nav-build'); check('Build tab renders', await page.locator('#goal').count() == 1)
        check('Claude-only buttons (polish/weave) are hidden when there is no Claude access', await page.locator('[data-act=weave]').count() == 0)
        await page.click('#nav-team'); await page.wait_for_selector('.empty h2:has-text("Open the team workspace")')
        check('Team asks for the owner key first (no connector setup wording)', 'owner key' in (await page.inner_text('#t-body')).lower() and 'connector' not in (await page.inner_text('#t-body')).lower())
        await page.fill('#t-key', 'wrong-key'); await page.click('[data-t=refresh]'); await page.wait_for_function("document.querySelector('#toast')?.textContent.includes('Wrong owner key') || document.querySelector('#t-body').textContent.includes('Wrong owner key')", timeout=8000)
        check('wrong key is rejected', True)
        await page.fill('#t-key', KEY); await page.click('[data-t=refresh]'); await page.wait_for_selector('.tchip.ok')
        check('Team opens for the owner', 'Connected as' in await page.inner_text('.tchipbox') and 'owner' in (await page.inner_text('.tchipbox')).lower(), await page.inner_text('.tchipbox'))
        # --- import files as opaque resources
        await page.click('[data-t=sub][data-k=files]'); await page.fill('#tf-tag', 'ntree/manifest')
        bom = b'\xef\xbb\xbf{"name":"demo","items":[1,2,3]}\r\n'; binb = bytes(range(256)) * 3
        await page.set_input_files('#tf-files', [{'name': 'demo.ntree', 'mimeType': 'application/json', 'buffer': bom}, {'name': 'asset.ntn', 'mimeType': 'application/octet-stream', 'buffer': binb}])
        await page.wait_for_selector('.frow >> text=imports/asset.ntn')
        r1 = owner('read_file', path='imports/demo.ntree')['payload']; r2 = owner('read_file', path='imports/asset.ntn')['payload']
        check('text resource stored byte-exact (BOM + CRLF)', r1['encoding'] == 'utf8' and r1['content'].encode('utf-8') == bom, r1.get('content'))
        check('format tag recorded, owner is the human owner, rev 1', r1['format'] == 'ntree/manifest' and r1['owner'] == 'owner' and r1['rev'] == 1, r1)
        check('binary resource stored as base64 with the SHA-256 of the original bytes', r2['encoding'] == 'base64' and base64.b64decode(r2['content']) == binb and r2['sha'] == hashlib.sha256(binb).hexdigest())
        await page.set_input_files('#tf-files', [{'name': 'demo.ntree', 'mimeType': 'application/json', 'buffer': bom + b'x'}]); await page.wait_for_function("document.body.innerText.includes('r2')", timeout=8000)
        check('re-import creates revision 2', owner('read_file', path='imports/demo.ntree')['payload']['rev'] == 2)
        # share a Kitbash part (parts live in this browser; the workspace gets a copy)
        await page.evaluate("state.skills['p1'] = {id:'p1', name:'lerp', kind:'fn', lang:'js', code:'const lerp=(a,b,t)=>a+(b-a)*t', project:'demo', path:'a.js', line:1, summary:'x', tags:[], provides:[], requires:[], uses:[], pkgs:[], hits:0, created:Date.now()}; rebuild()")
        await page.click('[data-t=sub][data-k=chat]'); await page.click('[data-t=sub][data-k=files]'); await page.click('[data-t=share-part]'); await page.wait_for_selector('.frow >> text=parts/p1.json')
        check('part shared as kitbash/part', owner('read_file', path='parts/p1.json')['payload']['format'] == 'kitbash/part')
        await page.screenshot(path='/tmp/sa-files.png')
        # --- chat: Both -> Claude gets an inbox message (no live Claude here), OpenAI agent answers
        await page.click('[data-t=sub][data-k=chat]'); await page.select_option('#t-to', 'both'); await page.fill('#t-draft', 'Please look over the imports and say hello.'); await page.click('[data-t=send]')
        await page.wait_for_selector('.msg:has-text("Hello from the embedded OpenAI agent")', timeout=20000)
        msgs = api('get_messages', limit=50)['payload']
        check('owner message posted as owner, addressed to everyone', any(m['sender'] == 'owner' and m['recipient'] == 'all' and 'look over the imports' in m['body'] for m in msgs))
        check('OpenAI agent reply posted as openai-api', any(m['sender'] == 'openai-api' and 'Hello from the embedded' in m['body'] for m in msgs))
        check('no fake Claude reply was invented', not any(m['sender'] == 'claude' for m in msgs))
        await page.select_option('#t-to', 'chatgpt'); await page.fill('#t-draft', 'ChatGPT: please review parts/p1.json when you connect.'); await page.click('[data-t=send]'); await page.wait_for_selector('.msg:has-text("ChatGPT: please review")')
        check('ChatGPT message addressed to chatgpt', any(m['recipient'] == 'chatgpt' and m['sender'] == 'owner' for m in api('get_messages', limit=50)['payload']))
        await page.screenshot(path='/tmp/sa-chat.png')
        # --- tasks + sequential handoff + embedded agent run
        await page.click('[data-t=sub][data-k=tasks]'); await page.fill('#tk-title', 'Tidy the demo manifest'); await page.select_option('#tk-asg', 'claude'); await page.fill('#tk-files', 'imports/demo.ntree'); await page.click('[data-t=new-task]')
        await page.wait_for_selector('.tcard:has-text("Tidy the demo manifest")')
        tid = [t for t in api('list_tasks')['payload'] if t['title'] == 'Tidy the demo manifest'][0]['id']
        card = page.locator('.tcard', has_text='Tidy the demo manifest'); await card.locator('[data-t=hand-sel]').select_option('openai-api'); await card.locator('[data-t=handoff]').click()
        await page.wait_for_selector('.tcard:has-text("Tidy the demo manifest") >> text=Run OpenAI agent')
        check('handoff moved the task to the OpenAI agent', api('get_task', id=tid)['payload']['assignee'] == 'openai-api')
        await page.locator('.tcard', has_text='Tidy the demo manifest').locator('[data-t=run-task]').click()
        await page.wait_for_function("document.querySelector('#toast').textContent.includes('OpenAI agent:')", timeout=20000)
        t = api('get_task', id=tid)['payload']; f = api('read_file', path='imports/demo.ntree')['payload']
        check('embedded agent finished and handed the task back to Claude', t['assignee'] == 'claude', t)
        check('embedded agent’s edit is revision 3, authored by openai-api, file still owned by the owner', f['rev'] == 3 and f['author'] == 'openai-api' and f['owner'] == 'owner' and f['content'].endswith('- edited by openai-api'), {k: f.get(k) for k in ('rev', 'author', 'owner')})
        # --- approvals
        api('propose_change', path='imports/asset.ntn', content='dGVzdA==', base_rev=1, encoding='base64', rationale='ui test')
        check('claude cannot write an owner-owned file directly', api('write_file', path='imports/asset.ntn', content='nope', base_rev=1)['err'])
        await page.click('[data-t=sub][data-k=approvals]'); await page.click('[data-t=refresh]'); await page.wait_for_selector('.tcard:has-text("proposal")')
        await page.fill('#t-key', ''); await page.click('[data-t=decide][data-d=approve]'); await page.wait_for_function("document.querySelector('#toast').textContent.toLowerCase().includes('owner key')")
        check('approval blocked without the owner key', api('read_file', path='imports/asset.ntn')['payload']['rev'] == 1)
        # with no key the workspace closes itself (standalone has no other identity); typing the key again reopens it
        await page.wait_for_selector('.empty h2:has-text("Open the team workspace")')
        await page.fill('#t-key', KEY); await page.click('[data-t=refresh]'); await page.wait_for_selector('.tchip.ok')
        await page.click('[data-t=sub][data-k=approvals]'); await page.click('[data-t=decide][data-d=approve]'); await page.wait_for_function("!document.querySelector('[data-t=decide]')", timeout=8000)
        check('approved proposal applied as a new revision', api('read_file', path='imports/asset.ntn')['payload']['rev'] == 2)
        # --- agents and checkpoints
        await page.click('[data-t=sub][data-k=agents]'); await page.wait_for_selector('.tcard:has-text("openai-api")')
        await page.locator('.tcard', has_text='openai-api').locator('[data-t=toggle-agent]').click(); await page.wait_for_selector('.tcard:has-text("openai-api") >> text=disabled')
        check('agent disabled via registry', any(a['id'] == 'openai-api' and not a['enabled'] for a in api('list_agents')['payload']))
        await page.locator('.tcard', has_text='openai-api').locator('[data-t=toggle-agent]').click(); await page.wait_for_selector('.tcard:has-text("openai-api") >> text=enabled')
        await page.click('[data-t=sub][data-k=files]'); await page.fill('#tc-label', 'after-ui'); await page.click('[data-t=checkpoint]'); await page.wait_for_function("document.body.innerText.includes('after-ui')", timeout=8000)
        check('checkpoint recorded', any(c.get('label') == 'after-ui' for c in api('list_checkpoints')['payload']))
        # --- persistence: reload the page, key is remembered for the tab, data is still there
        await page.reload(); await page.wait_for_selector('#nav-team'); await page.click('#nav-team'); await page.wait_for_selector('.tchip.ok', timeout=10000)
        check('after a reload the tab reopens with the remembered key and shows the stored files', 'ok' and await page.locator('.tchip.ok').count() == 1)
        await page.screenshot(path='/tmp/sa-team.png')
        check('no page errors', not errs, errs)
        await b.close()
    print(f'\n{ok} passed, {bad} failed'); sys.exit(1 if bad else 0)
try: asyncio.run(main())
except Exception as e:
    print('CRASH', type(e).__name__, str(e)[:200])
    sys.exit(2)

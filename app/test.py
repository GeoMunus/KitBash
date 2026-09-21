import asyncio, json, base64, sys
import os; TEST_URL = 'file://' + os.path.join(os.path.dirname(os.path.abspath(__file__)), 'test.html')
from playwright.async_api import async_playwright

STUB = """
window.__saved = {};
const store = new Map();
const mkDoc = (id) => ({ id, exists: store.has(id), data: () => store.get(id), metadata:{} });
const fakeDb = { collection: (name) => ({ get: async () => ({ docs: [...store.keys()].map(mkDoc) }) }),
  doc: (path) => ({ set: async (d) => { store.set(path.split('/').pop(), JSON.parse(JSON.stringify(d))); }, delete: async () => { store.delete(path.split('/').pop()); }, get: async () => mkDoc(path.split('/').pop()) }) };
const fakeDl = { save: async (r) => { const b = r.data; if (b instanceof Blob) { const buf = new Uint8Array(await b.arrayBuffer()); let s=''; for (const x of buf) s+=String.fromCharCode(x); window.__saved[r.filename] = btoa(s); } else window.__saved[r.filename] = r.data; return {status:'saved'}; } };
const fakeSample = async (input, opts) => { const t = '```html\\n<!doctype html><html><body><h1>woven</h1></body></html>\\n```\\nDone.'; opts && opts.onText && opts.onText({text:t, delta:t}); return {text:t, truncated:false}; };
fakeSample.json = async (input) => ({ parts: [{i:0, summary:'Polished summary.', tags:['polished']}] });
window.claude = { use: async (n) => ({ db: fakeDb, downloads: fakeDl, sample: fakeSample })[n] || null };
"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 400, 'height': 860})
        errs = []
        pg.on('console', lambda m: errs.append(f'{m.type}: {m.text}') if m.type in ('error','warning') else None)
        pg.on('pageerror', lambda e: errs.append(f'PAGEERROR: {e}'))
        await pg.add_init_script(STUB)
        await pg.goto(TEST_URL)
        await pg.wait_for_timeout(1200)
        info = await pg.evaluate("""() => { const p = state.ws[0]; return { cands: p.cands.map(c => [c.kind, c.name, c.uses.map(u=>state.ws[0].cands.find(x=>x.id===u).name)]), skipped: p.skipped }; }""")
        print(json.dumps(info, indent=0))
        await pg.screenshot(path='/tmp/shot-import.png')
        # memorize sample
        await pg.click('[data-act="memorize"]')
        await pg.wait_for_timeout(300)
        print('backend', await pg.evaluate("Backend.kind"), 'skills', await pg.evaluate("all().length"))
        # search
        await pg.click('#nav-parts'); await pg.fill('#q', 'animation loop'); await pg.wait_for_timeout(200)
        print('recall animation loop:', await pg.evaluate("recall(state.index,'animation loop').slice(0,4).map(r=>r.s.name+' '+r.rel.toFixed(2))"))
        print('recall pulsing title:', await pg.evaluate("recall(state.index,'a starfield screensaver with a glowing title',10).map(r=>r.s.name+' '+r.rel.toFixed(2))"))
        # build
        await pg.click('#nav-import'); await pg.click('[data-act="try-build"]'); await pg.wait_for_timeout(300)
        print('plan', await pg.evaluate("state.build.plan.items.map(i=>state.skills[i.id].name+':'+i.on)"))
        await pg.click('[data-act="assemble"]'); await pg.wait_for_timeout(1200)
        res = await pg.evaluate("({html: state.build.result.html, notes: state.build.result.notes, order: state.build.result.order.map(i=>state.skills[i].name)})")
        print('order', res['order']); print('notes', res['notes'])
        open('/tmp/assembled.html','w').write(res['html'])
        await pg.screenshot(path='/tmp/shot-build.png')
        # preview iframe runs? check canvas nonblank
        fr = pg.frame_locator('#pv')
        print('title in preview:', await fr.locator('.title').inner_text())
        # save build + weave
        await pg.click('[data-act="save-build"]'); await pg.wait_for_timeout(200)
        await pg.click('[data-act="weave"]'); await pg.wait_for_timeout(600)
        print('woven?', await pg.evaluate("state.build.result.how"))
        # export zip
        await pg.click('#nav-parts'); await pg.fill('#q',''); await pg.wait_for_timeout(100)
        await pg.click('[data-act="export"]'); await pg.wait_for_timeout(300)
        z = await pg.evaluate("window.__saved['kitbash-skills.zip']")
        open('/tmp/skills.zip','wb').write(base64.b64decode(z))
        # reload -> persisted?
        await pg.reload(); await pg.wait_for_timeout(200)
        print('errors:', errs)
        await pg.screenshot(path='/tmp/shot-after.png')
        await b.close()
asyncio.run(main())

import asyncio, json
import os; TEST_URL = 'file://' + os.path.join(os.path.dirname(os.path.abspath(__file__)), 'test.html')
from playwright.async_api import async_playwright
exec(open('test.py').read().split("async def main")[0].split("import asyncio, json, base64, sys")[1].split("from playwright.async_api import async_playwright")[1])
JSX = """import React, { useState } from 'react';
import { format } from 'date-fns';

// A counter button that remembers how many times it was tapped.
export default function Counter({ label = 'Taps' }) {
  const [n, setN] = useState(0);
  return (
    <button onClick={() => setN(n + 1)}>{label}: {n}</button>
  );
}

export const useToggle = (initial = false) => {
  const [on, set] = useState(initial);
  return [on, () => set(v => !v)];
};

const THEME = {
  bg: '#111',
  fg: '#eee',
  accent: '#0f8'
};

export const Badge = ({ text }) => <span className="badge">{text}</span>;
interface Props { a: number }
"""
PY = '''import math

def dist(a, b):
    """Euclidean distance between two points."""
    return math.hypot(a[0]-b[0], a[1]-b[1])

class Grid:
    def __init__(self, n):
        self.n = n

    def cells(self):
        return self.n * self.n

SPEED = 3
'''
SKILL = """---
name: pixel-art
description: Draw pixel art on a canvas with palette limits.
---
# Pixel art
Use small palettes.
"""
GLSL = "precision mediump float;\nvoid main(){ gl_FragColor = vec4(1.0); }\n"
PKG = '{"name":"demo","dependencies":{"react":"^18","three":"^0.160"},"scripts":{"dev":"vite"}}'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(); errs=[]
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(STUB); await pg.goto(TEST_URL); await pg.wait_for_timeout(500)
        out = await pg.evaluate("""(files) => { const r = {}; for (const [k,v] of Object.entries(files)) r[k] = extractFile('t', k, v).map(s => [s.kind, s.name, s.summary.slice(0,60), s.uses.length]); return r; }""", {'src/Counter.jsx': JSX, 'lib/geo.py': PY, 'skills/pixel/SKILL.md': SKILL, 'fx/wave.frag': GLSL, 'package.json': PKG})
        for k,v in out.items():
            print(k)
            for row in v: print('   ', row)
        # manual sheet flow
        await pg.click('#nav-parts'); await pg.click('[data-act="new"]'); await pg.fill('#f-name','fadeIn'); await pg.fill('#f-code','function fadeIn(el){ el.style.opacity=1; }'); await pg.click('[data-act="sheet-save"]'); await pg.wait_for_timeout(200)
        print('manual added:', await pg.evaluate("all().map(s=>s.name+':'+s.project)"))
        # paste flow
        await pg.click('#nav-import'); await pg.click('[data-act="intake"][data-k="paste"]'); await pg.fill('#p-text', PY); await pg.fill('#p-name','geo.py'); await pg.click('[data-act="paste-add"]'); await pg.wait_for_timeout(200)
        print('pasted project:', await pg.evaluate("state.ws.map(w=>w.name+':'+w.cands.length)"))
        print('errors', errs)
        await b.close()
asyncio.run(main())

import asyncio
import os; TEST_URL = 'file://' + os.path.join(os.path.dirname(os.path.abspath(__file__)), 'test.html')
from playwright.async_api import async_playwright
exec(open('test.py').read().split("async def main")[0].split("import asyncio, json, base64, sys")[1].split("from playwright.async_api import async_playwright")[1])
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 400, 'height': 860}, device_scale_factor=1)
        await pg.add_init_script(STUB)
        await pg.goto(TEST_URL); await pg.wait_for_timeout(800)
        await pg.screenshot(path='/tmp/a-import.png')
        await pg.click('[data-act="memorize"]'); await pg.wait_for_timeout(200)
        await pg.click('[data-act="try-build"]'); await pg.wait_for_timeout(300)
        await pg.click('[data-act="assemble"]'); await pg.wait_for_timeout(1500)
        await pg.evaluate("document.querySelector('#result').scrollIntoView()")
        await pg.screenshot(path='/tmp/b-build.png')
        await pg.click('#nav-parts'); await pg.fill('#q','star'); await pg.wait_for_timeout(200)
        await pg.click('.part-main >> nth=1'); await pg.wait_for_timeout(200)
        await pg.screenshot(path='/tmp/c-parts.png')
        pg2 = await b.new_page(viewport={'width': 1200, 'height': 800}, color_scheme='dark')
        await pg2.add_init_script(STUB); await pg2.goto(TEST_URL); await pg2.wait_for_timeout(800)
        await pg2.screenshot(path='/tmp/d-wide-dark.png')
        await b.close()
asyncio.run(main())

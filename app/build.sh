#!/bin/bash
# Builds ../kitbash.html (the single-file Kitbash app served by server.js and publishable as a Claude artifact)
# and app/test.html (a wrapper the browser tests open).
cd "$(dirname "$0")"
{
echo '<title>Kitbash</title>'
echo '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
echo '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">'
echo '<style>'; cat src/style.css; echo '</style>'
echo '<div id="root"></div>'
echo '<script>'; cat src/extract.js src/core.js src/sample.js src/team.js src/app.js; echo '</script>'
} > ../kitbash.html
{ echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>'; cat ../kitbash.html; echo '</body></html>'; } > test.html
wc -c ../kitbash.html
